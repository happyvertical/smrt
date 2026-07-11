/**
 * LeadCollection — collection manager for Lead, including qualification into
 * opportunities, audited duplicate merges, and merge-aware history reads.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Lead } from '../models/Lead.js';
import type { Opportunity } from '../models/Opportunity.js';
import type { PipelineDefinition } from '../models/PipelineDefinition.js';
import type { PipelineStage } from '../models/PipelineStage.js';
import type { SalesActivity } from '../models/SalesActivity.js';
import type {
  LeadStatus,
  MergeLeadsParams,
  MergeLeadsResult,
  QualifyLeadParams,
} from '../types.js';
import { OpportunityCollection } from './OpportunityCollection.js';
import { PipelineDefinitionCollection } from './PipelineDefinitionCollection.js';
import { SalesActivityCollection } from './SalesActivityCollection.js';

/**
 * Winner contact fields that {@link LeadCollection.mergeLeads} fills from the
 * loser when (and only when) the winner's value is empty. Non-empty winner
 * data is never overwritten.
 */
const MERGE_FILL_CONTACT_FIELDS = [
  'contactName',
  'email',
  'phone',
  'organizationName',
] as const;

/** Narrow a possibly-unset SmrtObject id into a usable string. */
function requireId(value: string | null | undefined, what: string): string {
  if (!value) {
    throw new Error(`LeadCollection: ${what} has no id`);
  }
  return value;
}

export class LeadCollection extends SmrtCollection<Lead> {
  static readonly _itemClass = Lead;

  private opportunityCollectionPromise: Promise<OpportunityCollection> | null =
    null;
  private pipelineCollectionPromise: Promise<PipelineDefinitionCollection> | null =
    null;
  private activityCollectionPromise: Promise<SalesActivityCollection> | null =
    null;

  /** Sibling opportunity collection sharing this collection's DB connection. */
  private async getOpportunityCollection(): Promise<OpportunityCollection> {
    if (!this.opportunityCollectionPromise) {
      this.opportunityCollectionPromise = OpportunityCollection.create({
        db: this.db,
      });
    }
    return this.opportunityCollectionPromise;
  }

  /** Sibling pipeline collection sharing this collection's DB connection. */
  private async getPipelineCollection(): Promise<PipelineDefinitionCollection> {
    if (!this.pipelineCollectionPromise) {
      this.pipelineCollectionPromise = PipelineDefinitionCollection.create({
        db: this.db,
      });
    }
    return this.pipelineCollectionPromise;
  }

  /** Sibling activity collection sharing this collection's DB connection. */
  private async getActivityCollection(): Promise<SalesActivityCollection> {
    if (!this.activityCollectionPromise) {
      this.activityCollectionPromise = SalesActivityCollection.create({
        db: this.db,
      });
    }
    return this.activityCollectionPromise;
  }

  /** Leads in a given lifecycle status, newest first. */
  async findByStatus(status: LeadStatus): Promise<Lead[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /** Leads owned by a given sales rep, newest first. */
  async findByOwner(ownerRepId: string): Promise<Lead[]> {
    return await this.list({
      where: { ownerRepId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Qualify a lead into an Opportunity.
   *
   * Transitions the lead to `qualified` (stamping `qualifiedAt` once) and
   * creates an Opportunity at the FIRST stage of the target pipeline —
   * `pipelineId` when given, otherwise the seeded default pipeline
   * (`ensureDefaultPipeline()`). The opportunity adopts the first stage's
   * probability, copies the lead's `sourceKind`/`sourceId` for reporting,
   * and defaults its name/owner from the lead. A `qualification`
   * SalesActivity is written on BOTH the lead and the opportunity.
   *
   * IDEMPOTENT: when the lead is already `qualified` and an opportunity
   * exists for it, that opportunity is returned unchanged (no new rows, no
   * new activities). A qualified lead with no opportunity (interrupted
   * earlier run) is healed by creating the missing opportunity.
   *
   * Illegal source statuses are rejected by the lead's save-time transition
   * guard (`disqualified`/`merged` leads cannot be qualified).
   *
   * @returns The (existing or newly created) opportunity
   */
  async qualify(params: QualifyLeadParams): Promise<Opportunity> {
    const lead = await this.get({ id: params.leadId });
    if (!lead) {
      throw new Error(
        `LeadCollection.qualify: lead '${params.leadId}' not found`,
      );
    }
    const leadId = requireId(lead.id, `lead '${params.leadId}'`);

    const opportunities = await this.getOpportunityCollection();
    if (lead.status === 'qualified') {
      const existing = await opportunities.findByLead(leadId);
      if (existing[0]) {
        return existing[0];
      }
    }

    // Resolve the target pipeline and its entry stage BEFORE mutating the
    // lead, so a bad pipelineId leaves the lead untouched.
    const pipelines = await this.getPipelineCollection();
    let pipeline: PipelineDefinition;
    let stages: PipelineStage[];
    if (params.pipelineId) {
      const found = await pipelines.get({ id: params.pipelineId });
      if (!found) {
        throw new Error(
          `LeadCollection.qualify: pipeline '${params.pipelineId}' not found`,
        );
      }
      pipeline = found;
      stages = await pipelines.getStages(requireId(pipeline.id, 'pipeline'));
    } else {
      ({ pipeline, stages } = await pipelines.ensureDefaultPipeline({
        ...(lead.tenantId !== null ? { tenantId: lead.tenantId } : {}),
      }));
    }
    const firstStage = stages[0];
    if (!firstStage) {
      throw new Error(
        `LeadCollection.qualify: pipeline '${pipeline.key || pipeline.id}' has no stages`,
      );
    }

    if (lead.status !== 'qualified') {
      lead.status = 'qualified'; // save-guard rejects illegal transitions
      if (!lead.qualifiedAt) {
        lead.qualifiedAt = params.now ?? new Date();
      }
      await lead.save();
    }

    const opportunity = await opportunities.create({
      ...(lead.tenantId !== null ? { tenantId: lead.tenantId } : {}),
      name: params.opportunityName ?? lead.name,
      leadId,
      ownerRepId: params.ownerRepId ?? lead.ownerRepId,
      pipelineId: pipeline.id ?? '',
      stageId: firstStage.id ?? '',
      probability: firstStage.probability,
      expectedValueCents: params.expectedValueCents ?? 0,
      currency: params.currency ?? 'USD',
      expectedCloseAt: params.expectedCloseAt ?? null,
      status: 'open',
      sourceKind: lead.sourceKind,
      sourceId: lead.sourceId,
    });
    const opportunityId = requireId(opportunity.id, 'created opportunity');

    const activities = await this.getActivityCollection();
    const tenantScope =
      lead.tenantId !== null ? { tenantId: lead.tenantId } : {};
    await activities.create({
      ...tenantScope,
      subjectKind: 'lead',
      subjectId: leadId,
      activityKind: 'qualification',
      summary: `Qualified into opportunity '${opportunity.name}'`,
      metadata: JSON.stringify({
        opportunityId,
        pipelineId: pipeline.id ?? '',
        stageId: firstStage.id ?? '',
        stageKey: firstStage.key,
      }),
    });
    await activities.create({
      ...tenantScope,
      subjectKind: 'opportunity',
      subjectId: opportunityId,
      activityKind: 'qualification',
      summary: `Created from qualified lead '${lead.name}'`,
      metadata: JSON.stringify({
        leadId,
        pipelineId: pipeline.id ?? '',
        stageId: firstStage.id ?? '',
        stageKey: firstStage.key,
      }),
    });

    return opportunity;
  }

  /**
   * Audited duplicate merge: fold the `loserId` lead into the `winnerId`
   * lead.
   *
   * Validations: the ids must differ, both leads must exist, the loser must
   * not already be merged, the winner must not itself be merged (merge into
   * the chain head instead), and the merge must not create a
   * `mergedIntoId` cycle.
   *
   * Effects:
   * - EMPTY winner contact fields (`contactName`/`email`/`phone`/
   *   `organizationName`) are filled from the loser; non-empty winner data
   *   is never overwritten;
   * - the loser's acquisition context is appended into the winner's under a
   *   `mergedSources` array (both histories preserved verbatim);
   * - the loser becomes terminal: `status: 'merged'` +
   *   `mergedIntoId: winnerId`;
   * - a `merge` SalesActivity is written on BOTH leads, each carrying a full
   *   pre-merge loser snapshot in metadata;
   * - the loser's existing activities STAY attached to the loser (history
   *   preserved in place) — read the combined trail via
   *   {@link activitiesIncludingMerged}.
   */
  async mergeLeads(params: MergeLeadsParams): Promise<MergeLeadsResult> {
    const { winnerId, loserId } = params;
    if (winnerId === loserId) {
      throw new Error(
        `LeadCollection.mergeLeads: winner and loser must be distinct leads (got '${winnerId}' twice)`,
      );
    }
    const winner = await this.get({ id: winnerId });
    if (!winner) {
      throw new Error(
        `LeadCollection.mergeLeads: winner lead '${winnerId}' not found`,
      );
    }
    const loser = await this.get({ id: loserId });
    if (!loser) {
      throw new Error(
        `LeadCollection.mergeLeads: loser lead '${loserId}' not found`,
      );
    }
    if (loser.status === 'merged') {
      throw new Error(
        `LeadCollection.mergeLeads: lead '${loserId}' is already merged into '${loser.mergedIntoId}'`,
      );
    }
    if (winner.status === 'merged') {
      throw new Error(
        `LeadCollection.mergeLeads: winner lead '${winnerId}' has itself been merged into ` +
          `'${winner.mergedIntoId}' — merge into the chain head instead`,
      );
    }

    // Cycle guard (defense in depth for raw-set mergedIntoId data): walking
    // the winner's merge ancestry must never reach the loser.
    const visited = new Set<string>([winnerId]);
    let cursor = winner.mergedIntoId;
    while (cursor) {
      if (cursor === loserId) {
        throw new Error(
          `LeadCollection.mergeLeads: merging '${loserId}' into '${winnerId}' would create a merge cycle`,
        );
      }
      if (visited.has(cursor)) break; // pre-existing cycle in data — stop walking
      visited.add(cursor);
      const ancestor = await this.get({ id: cursor });
      cursor = ancestor?.mergedIntoId ?? '';
    }

    // Full pre-merge snapshot of the loser for both audit rows.
    const loserSnapshot = loser.toJSON() as Record<string, unknown>;

    // Fill EMPTY winner contact fields from the loser — never overwrite.
    const filledFields: string[] = [];
    for (const fieldName of MERGE_FILL_CONTACT_FIELDS) {
      if (winner[fieldName] === '' && loser[fieldName] !== '') {
        winner[fieldName] = loser[fieldName];
        filledFields.push(fieldName);
      }
    }

    // Preserve BOTH acquisition histories: append the loser's context (plus
    // its source pointer) under the winner's `mergedSources` array.
    const winnerContext = winner.getAcquisitionContext();
    const priorSources = winnerContext.mergedSources;
    const mergedSources = Array.isArray(priorSources) ? [...priorSources] : [];
    mergedSources.push({
      leadId: loserId,
      mergedAt: new Date().toISOString(),
      sourceKind: loser.sourceKind,
      sourceId: loser.sourceId,
      acquisitionContext: loser.getAcquisitionContext(),
    });
    winner.setAcquisitionContext({ ...winnerContext, mergedSources });

    await winner.save();

    loser.status = 'merged';
    loser.mergedIntoId = winnerId;
    await loser.save();

    const activities = await this.getActivityCollection();
    const actorProfileId = params.actorProfileId ?? '';
    const reason = params.reason ?? '';
    const auditDetail = {
      winnerId,
      loserId,
      reason,
      filledFields,
      loserSnapshot,
    };
    await activities.create({
      ...(winner.tenantId !== null ? { tenantId: winner.tenantId } : {}),
      subjectKind: 'lead',
      subjectId: winnerId,
      activityKind: 'merge',
      summary: `Merged duplicate lead '${loser.name}' into this lead`,
      actorProfileId,
      metadata: JSON.stringify({ ...auditDetail, direction: 'absorbed' }),
    });
    await activities.create({
      ...(loser.tenantId !== null ? { tenantId: loser.tenantId } : {}),
      subjectKind: 'lead',
      subjectId: loserId,
      activityKind: 'merge',
      summary: `Merged into lead '${winner.name}'`,
      actorProfileId,
      metadata: JSON.stringify({ ...auditDetail, direction: 'merged_away' }),
    });

    return { winner, loser };
  }

  /**
   * The lead's activity trail INCLUDING the trails of every lead merged into
   * it, transitively (losers keep their own activities; this read
   * re-assembles the full history across `mergedIntoId` chains).
   *
   * Traversal is breadth-first over merge children with a visited-set guard,
   * so malformed cyclic data cannot loop. Results are in chronological
   * order.
   */
  async activitiesIncludingMerged(leadId: string): Promise<SalesActivity[]> {
    const visited = new Set<string>();
    let frontier = [leadId];
    while (frontier.length > 0) {
      const batch = frontier.filter((id) => id && !visited.has(id));
      if (batch.length === 0) break;
      for (const id of batch) {
        visited.add(id);
      }
      const children = await this.list({
        where: { 'mergedIntoId in': batch },
      });
      frontier = children
        .map((child) => child.id ?? '')
        .filter((id) => id !== '');
    }

    const activities = await this.getActivityCollection();
    return await activities.list({
      where: { subjectKind: 'lead', 'subjectId in': Array.from(visited) },
      orderBy: 'created_at ASC',
    });
  }
}

export default LeadCollection;
