import type { LeadCollection } from '../collections/LeadCollection.js';
import type { LeadMergeCollection } from '../collections/LeadMergeCollection.js';
import type { OpportunityCollection } from '../collections/OpportunityCollection.js';
import type { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import type { PipelineStageCollection } from '../collections/PipelineStageCollection.js';
import type { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import type { Lead } from '../models/Lead.js';
import type { Opportunity } from '../models/Opportunity.js';
import type { PipelineDefinition } from '../models/PipelineDefinition.js';
import type { PipelineStage } from '../models/PipelineStage.js';
import type {
  AcquisitionEvent,
  ConvertLeadToOpportunityArgs,
  ConvertLeadToOpportunityResult,
  CreateLeadArgs,
  DefaultPipelineStageDefinition,
  EnsureDefaultPipelineResult,
  LeadMergeSnapshot,
  MergeLeadArgs,
  MergeLeadResult,
  MoveOpportunityArgs,
  PipelineStageKey,
  QualifyLeadArgs,
} from '../types.js';
import { DEFAULT_PIPELINE_STAGE_DEFINITIONS } from '../types.js';

export interface SalesServiceOptions {
  leads: LeadCollection;
  opportunities: OpportunityCollection;
  pipelines: PipelineDefinitionCollection;
  stages: PipelineStageCollection;
  activities: SalesActivityCollection;
  leadMerges: LeadMergeCollection;
}

export class SalesService {
  private readonly leads: LeadCollection;
  private readonly opportunities: OpportunityCollection;
  private readonly pipelines: PipelineDefinitionCollection;
  private readonly stages: PipelineStageCollection;
  private readonly activities: SalesActivityCollection;
  private readonly leadMerges: LeadMergeCollection;

  constructor(options: SalesServiceOptions) {
    this.leads = options.leads;
    this.opportunities = options.opportunities;
    this.pipelines = options.pipelines;
    this.stages = options.stages;
    this.activities = options.activities;
    this.leadMerges = options.leadMerges;
  }

  async createLead(tenantId: string, data: CreateLeadArgs): Promise<Lead> {
    const lead = await this.leads.create({
      tenantId,
      name: data.name,
      email: data.email ?? '',
      organization: data.organization ?? '',
      ownerId: data.ownerId ?? null,
      status: 'new',
    });

    if (data.acquisitionEvent) {
      lead.recordAcquisition(data.acquisitionEvent);
    }

    await lead.save();

    if (data.acquisitionEvent) {
      await this.appendActivity({
        tenantId,
        leadId: lead.id ?? null,
        type: 'note',
        actorId: data.ownerId ?? null,
        summary: `Lead captured from ${data.acquisitionEvent.source}`,
        details: {
          acquisitionEvent: data.acquisitionEvent,
        },
      });
    }

    return lead;
  }

  async qualifyLead(args: QualifyLeadArgs): Promise<Lead> {
    const lead = await this.requireLead(args.leadId);
    lead.qualify(args.actorId, args.summary);
    await lead.save();
    await this.appendActivity({
      tenantId: lead.tenantId,
      leadId: lead.id ?? null,
      type: 'qualification',
      actorId: args.actorId ?? null,
      summary: args.summary?.trim()
        ? `Lead qualified: ${args.summary.trim()}`
        : 'Lead qualified',
      details: {
        qualifiedAt: lead.qualifiedAt?.toISOString() ?? null,
        qualifiedById: lead.qualifiedById,
      },
    });
    return lead;
  }

  async ensureDefaultPipeline(
    tenantId: string,
  ): Promise<EnsureDefaultPipelineResult> {
    let pipeline = await this.pipelines.getDefault(tenantId);
    if (!pipeline) {
      pipeline = await this.pipelines.create({
        tenantId,
        key: 'default',
        name: 'Default Sales Pipeline',
        description:
          'Default lead qualification and opportunity progression pipeline',
        active: true,
        isDefault: true,
      });
      await pipeline.save();
    }

    await this.normalizeDefaultFlags(tenantId, pipeline);
    const stages = await this.ensurePipelineStages(
      pipeline,
      DEFAULT_PIPELINE_STAGE_DEFINITIONS,
    );

    return {
      pipeline: {
        id: pipeline.id ?? '',
        key: pipeline.key,
        name: pipeline.name,
      },
      stageIdsByKey: Object.fromEntries(
        stages
          .filter((stage) => stage.id)
          .map((stage) => [stage.key, stage.id as string]),
      ),
    };
  }

  async convertLeadToOpportunity(
    args: ConvertLeadToOpportunityArgs,
  ): Promise<ConvertLeadToOpportunityResult> {
    const lead = await this.requireLead(args.leadId);
    if (lead.mergedIntoLeadId) {
      throw new Error(
        `Lead '${lead.id}' has been merged into '${lead.mergedIntoLeadId}'`,
      );
    }

    const existing = await this.opportunities.getByLeadId(lead.id ?? '');
    if (existing?.id) {
      const currentStage = await this.requireStage(existing.stageId);
      return {
        opportunityId: existing.id,
        leadId: lead.id ?? '',
        created: false,
        stageKey: currentStage.key,
      };
    }

    const pipeline =
      args.pipelineId?.trim() ||
      (await this.ensureDefaultPipeline(lead.tenantId)).pipeline.id;
    const stageKey = args.stageKey ?? 'qualified';
    const stage = await this.resolveStage(pipeline, stageKey);

    const { opportunity, created } =
      await this.createOpportunityWithRaceHandling({
        tenantId: lead.tenantId,
        leadId: lead.id ?? '',
        pipelineId: pipeline,
        stageId: stage.id ?? '',
        ownerId: args.ownerId ?? lead.ownerId,
        name: args.name ?? this.defaultOpportunityName(lead),
        expectedValue: args.expectedValue ?? 0.0,
        currency: args.currency ?? 'USD',
        nextAction: args.nextAction ?? '',
        outcome: stage.outcome,
        lastStageChangeAt: new Date(),
      });
    if (!created) {
      const currentStage = await this.requireStage(opportunity.stageId);
      return {
        opportunityId: opportunity.id ?? '',
        leadId: lead.id ?? '',
        created: false,
        stageKey: currentStage.key,
      };
    }
    opportunity.moveTo(stage);
    await opportunity.save();

    lead.markConverted();
    if (args.ownerId?.trim()) {
      lead.assign(args.ownerId);
    }
    await lead.save();

    await this.appendActivity({
      tenantId: lead.tenantId,
      leadId: lead.id ?? null,
      opportunityId: opportunity.id ?? null,
      type: 'conversion',
      actorId: args.actorId ?? null,
      summary: `Lead converted into opportunity at ${stage.name}`,
      details: {
        opportunityId: opportunity.id,
        pipelineId: opportunity.pipelineId,
        stageId: opportunity.stageId,
        stageKey: stage.key,
      },
    });

    return {
      opportunityId: opportunity.id ?? '',
      leadId: lead.id ?? '',
      created: true,
      stageKey: stage.key,
    };
  }

  async moveOpportunity(args: MoveOpportunityArgs): Promise<Opportunity> {
    const opportunity = await this.requireOpportunity(args.opportunityId);
    const previousStageId = opportunity.stageId;
    const stage = args.stageId?.trim()
      ? await this.requireStage(args.stageId)
      : await this.resolveStage(
          opportunity.pipelineId,
          args.stageKey ?? 'qualified',
        );

    opportunity.moveTo(stage);
    if (args.nextAction !== undefined) {
      opportunity.nextAction = args.nextAction;
    }
    await opportunity.save();

    await this.appendActivity({
      tenantId: opportunity.tenantId,
      leadId: opportunity.leadId,
      opportunityId: opportunity.id ?? null,
      type: stage.terminal ? 'outcome' : 'stage_change',
      actorId: args.actorId ?? null,
      summary: stage.terminal
        ? `Opportunity moved to ${stage.name}`
        : `Opportunity advanced to ${stage.name}`,
      details: {
        fromStageId: previousStageId,
        toStageId: stage.id,
        stageKey: stage.key,
        outcome: stage.outcome,
        nextAction: opportunity.nextAction,
      },
    });

    return opportunity;
  }

  async mergeLeads(args: MergeLeadArgs): Promise<MergeLeadResult> {
    if (args.sourceLeadId === args.targetLeadId) {
      throw new Error('A lead cannot be merged into itself');
    }

    const source = await this.requireLead(args.sourceLeadId);
    const target = await this.requireLead(args.targetLeadId);
    if (source.tenantId !== target.tenantId) {
      throw new Error('Leads must belong to the same tenant to merge');
    }

    const existing = await this.leadMerges.findBySourceLeadId(source.id ?? '');
    if (existing?.id) {
      if (existing.targetLeadId !== target.id) {
        throw new Error(
          `Lead '${source.id}' has already been merged into '${existing.targetLeadId}'`,
        );
      }
      return {
        mergeId: existing.id,
        sourceLeadId: source.id ?? '',
        targetLeadId: target.id ?? '',
        created: false,
      };
    }

    const sourceOpportunity = await this.opportunities.getByLeadId(
      source.id ?? '',
    );
    const sourceActivities = this.combineActivities(
      await this.activities.forLead(source.id ?? ''),
      sourceOpportunity?.id
        ? await this.activities.forOpportunity(sourceOpportunity.id)
        : [],
    );
    const snapshot: LeadMergeSnapshot = {
      sourceLead: {
        id: source.id ?? '',
        tenantId: source.tenantId,
        name: source.name,
        email: source.email,
        organization: source.organization,
        ownerId: source.ownerId,
        status: source.status,
        qualificationSummary: source.qualificationSummary,
        qualifiedAt: source.qualifiedAt?.toISOString() ?? null,
        qualifiedById: source.qualifiedById,
      },
      sourceAcquisitionHistory: source.getAcquisitionHistory(),
      sourceActivities: sourceActivities.map((activity) => ({
        id: activity.id ?? '',
        type: activity.type,
        summary: activity.summary,
        occurredAt: activity.occurredAt.toISOString(),
        actorId: activity.actorId,
        details: activity.getDetails(),
        opportunityId: activity.opportunityId,
      })),
      sourceOpportunity: sourceOpportunity
        ? {
            id: sourceOpportunity.id ?? '',
            tenantId: sourceOpportunity.tenantId,
            leadId: sourceOpportunity.leadId,
            pipelineId: sourceOpportunity.pipelineId,
            stageId: sourceOpportunity.stageId,
            ownerId: sourceOpportunity.ownerId,
            name: sourceOpportunity.name,
            expectedValue: sourceOpportunity.expectedValue,
            currency: sourceOpportunity.currency,
            nextAction: sourceOpportunity.nextAction,
            outcome: sourceOpportunity.outcome,
            closedAt: sourceOpportunity.closedAt?.toISOString() ?? null,
            lastStageChangeAt:
              sourceOpportunity.lastStageChangeAt?.toISOString() ?? null,
          }
        : null,
      sourceOpportunityId: sourceOpportunity?.id ?? null,
    };

    for (const event of snapshot.sourceAcquisitionHistory) {
      target.recordAcquisition(
        this.mergeTaggedAcquisition(event, source.id ?? ''),
      );
    }
    if (!target.ownerId && source.ownerId) {
      target.ownerId = source.ownerId;
    }
    await target.save();

    const merge = await this.leadMerges.create({
      tenantId: target.tenantId,
      sourceLeadId: source.id ?? '',
      targetLeadId: target.id ?? '',
      actorId: args.actorId ?? null,
      mergedAt: new Date(),
    });
    merge.setSourceSnapshot(snapshot);
    await merge.save();

    source.markMerged(target.id ?? '');
    await source.save();

    await this.appendActivity({
      tenantId: target.tenantId,
      leadId: target.id ?? null,
      type: 'merge',
      actorId: args.actorId ?? null,
      summary: `Merged duplicate lead ${source.name || source.email || source.id}`,
      details: {
        mergeId: merge.id,
        sourceLeadId: source.id,
        preservedActivityCount: snapshot.sourceActivities.length,
        preservedAcquisitionCount: snapshot.sourceAcquisitionHistory.length,
      },
    });

    return {
      mergeId: merge.id ?? '',
      sourceLeadId: source.id ?? '',
      targetLeadId: target.id ?? '',
      created: true,
    };
  }

  private async normalizeDefaultFlags(
    tenantId: string,
    pipeline: PipelineDefinition,
  ): Promise<void> {
    const pipelines = await this.pipelines.list({
      where: { tenantId, isDefault: true },
    });
    for (const candidate of pipelines) {
      const shouldBeDefault = candidate.id === pipeline.id;
      if (candidate.isDefault !== shouldBeDefault) {
        candidate.isDefault = shouldBeDefault;
        await candidate.save();
      }
    }
    if (!pipeline.isDefault) {
      pipeline.isDefault = true;
      await pipeline.save();
    }
  }

  private async ensurePipelineStages(
    pipeline: PipelineDefinition,
    defaults: readonly DefaultPipelineStageDefinition[],
  ): Promise<PipelineStage[]> {
    const stages: PipelineStage[] = [];
    for (const definition of defaults) {
      let stage = await this.stages.findByKey(
        pipeline.id ?? '',
        definition.key,
      );
      if (!stage) {
        stage = await this.stages.create({
          tenantId: pipeline.tenantId,
          pipelineId: pipeline.id ?? '',
          key: definition.key,
          name: definition.name,
          sortOrder: definition.sortOrder,
          terminal: definition.terminal,
          outcome: definition.outcome,
        });
        await stage.save();
      }
      stages.push(stage);
    }
    return stages.sort((left, right) => left.sortOrder - right.sortOrder);
  }

  private defaultOpportunityName(lead: Lead): string {
    if (lead.organization.trim()) {
      return `${lead.organization.trim()} opportunity`;
    }
    if (lead.name.trim()) {
      return `${lead.name.trim()} opportunity`;
    }
    return 'New opportunity';
  }

  private mergeTaggedAcquisition(
    event: AcquisitionEvent,
    sourceLeadId: string,
  ): AcquisitionEvent {
    return {
      ...event,
      metadata: {
        ...(event.metadata ?? {}),
        mergedFromLeadId: sourceLeadId,
      },
    };
  }

  private combineActivities(
    leadActivities: Awaited<ReturnType<SalesActivityCollection['forLead']>>,
    opportunityActivities: Awaited<
      ReturnType<SalesActivityCollection['forOpportunity']>
    >,
  ) {
    const byIdentity = new Map<string, (typeof leadActivities)[number]>();
    for (const activity of [...leadActivities, ...opportunityActivities]) {
      const key =
        activity.id ??
        `${activity.type}:${activity.occurredAt.toISOString()}:${activity.summary}`;
      if (!byIdentity.has(key)) {
        byIdentity.set(key, activity);
      }
    }
    return [...byIdentity.values()].sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
  }

  private async appendActivity(args: {
    tenantId: string;
    leadId: string | null;
    opportunityId?: string | null;
    type:
      | 'note'
      | 'qualification'
      | 'conversion'
      | 'merge'
      | 'stage_change'
      | 'outcome';
    actorId: string | null;
    summary: string;
    details: Record<string, unknown>;
  }): Promise<void> {
    const activity = await this.activities.create({
      tenantId: args.tenantId,
      leadId: args.leadId,
      opportunityId: args.opportunityId ?? null,
      type: args.type,
      actorId: args.actorId,
      summary: args.summary,
      occurredAt: new Date(),
    });
    activity.setDetails(args.details);
    await activity.save();
  }

  private async createOpportunityWithRaceHandling(args: {
    tenantId: string;
    leadId: string;
    pipelineId: string;
    stageId: string;
    ownerId: string | null;
    name: string;
    expectedValue: number;
    currency: string;
    nextAction: string;
    outcome: Opportunity['outcome'];
    lastStageChangeAt: Date;
  }): Promise<{ opportunity: Opportunity; created: boolean }> {
    try {
      const opportunity = await this.opportunities.create(args);
      return { opportunity, created: true };
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) {
        throw error;
      }
      const winner = await this.opportunities.getByLeadId(args.leadId);
      if (!winner) {
        throw error;
      }
      return { opportunity: winner, created: false };
    }
  }

  private async resolveStage(
    pipelineId: string,
    stageKey: PipelineStageKey,
  ): Promise<PipelineStage> {
    const stage = await this.stages.findByKey(pipelineId, stageKey);
    if (!stage) {
      throw new Error(
        `Pipeline stage '${stageKey}' was not found for pipeline '${pipelineId}'`,
      );
    }
    return stage;
  }

  private async requireLead(leadId: string): Promise<Lead> {
    const lead = await this.leads.get({ id: leadId });
    if (!lead) {
      throw new Error(`Lead '${leadId}' not found`);
    }
    return lead;
  }

  private async requireOpportunity(
    opportunityId: string,
  ): Promise<Opportunity> {
    const opportunity = await this.opportunities.get({ id: opportunityId });
    if (!opportunity) {
      throw new Error(`Opportunity '${opportunityId}' not found`);
    }
    return opportunity;
  }

  private async requireStage(stageId: string): Promise<PipelineStage> {
    const stage = await this.stages.get({ id: stageId });
    if (!stage) {
      throw new Error(`Pipeline stage '${stageId}' not found`);
    }
    return stage;
  }

  private isDuplicateKeyError(err: unknown): boolean {
    const seen = new Set<unknown>();
    let current: unknown = err;

    while (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current);
      const value = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (
        value.code === '23505' ||
        value.code === 'VALIDATION_UNIQUE_CONSTRAINT'
      ) {
        return true;
      }
      const message = typeof value.message === 'string' ? value.message : '';
      if (
        /duplicate key|unique.+violat|code=23505|SQLITE_CONSTRAINT.*UNIQUE/i.test(
          message,
        )
      ) {
        return true;
      }
      current = value.cause;
    }

    return false;
  }
}
