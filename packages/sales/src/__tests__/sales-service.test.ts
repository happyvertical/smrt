import { describe, expect, it, vi } from 'vitest';
import {
  Lead,
  LeadMerge,
  Opportunity,
  PipelineDefinition,
  PipelineStage,
  SalesActivity,
} from '../models/index.js';
import { SalesService, type SalesServiceOptions } from '../services/index.js';
import { DEFAULT_PIPELINE_STAGE_DEFINITIONS } from '../types.js';

describe('SalesService', () => {
  it('filters default pipeline lookup and normalization by tenant id', async () => {
    const tenantDefault = new PipelineDefinition({
      tenantId: 'tenant-1',
      key: 'default',
      name: 'Tenant 1 Default',
      isDefault: true,
    });
    tenantDefault.id = 'pipeline-1';
    tenantDefault.save = vi.fn(async () => undefined);

    const otherTenantDefault = new PipelineDefinition({
      tenantId: 'tenant-2',
      key: 'default',
      name: 'Tenant 2 Default',
      isDefault: true,
    });
    otherTenantDefault.id = 'pipeline-2';
    otherTenantDefault.save = vi.fn(async () => undefined);

    const stages: PipelineStage[] = [];
    const stores = {
      leads: {},
      opportunities: {},
      pipelines: {
        getDefault: vi.fn(async (tenantId: string) =>
          tenantId === 'tenant-1' ? tenantDefault : null,
        ),
        list: vi.fn(
          async ({
            where,
          }: {
            where?: { tenantId?: string; isDefault?: boolean };
          } = {}) =>
            [tenantDefault, otherTenantDefault].filter(
              (pipeline) =>
                (where?.tenantId === undefined ||
                  pipeline.tenantId === where.tenantId) &&
                (where?.isDefault === undefined ||
                  pipeline.isDefault === where.isDefault),
            ),
        ),
        create: vi.fn(),
      },
      stages: {
        findByKey: vi.fn(
          async (pipelineId: string, key: string) =>
            stages.find(
              (stage) => stage.pipelineId === pipelineId && stage.key === key,
            ) ?? null,
        ),
        create: vi.fn(async (data) => {
          const stage = new PipelineStage(data);
          stage.id = `stage-${stages.length + 1}`;
          stage.save = vi.fn(async () => undefined);
          stages.push(stage);
          return stage;
        }),
      },
      activities: {},
      leadMerges: {},
    } as unknown as SalesServiceOptions;

    const result = await new SalesService(stores).ensureDefaultPipeline(
      'tenant-1',
    );

    expect(result.pipeline.id).toBe('pipeline-1');
    expect(stores.pipelines.getDefault).toHaveBeenCalledWith('tenant-1');
    expect(stores.pipelines.list).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', isDefault: true },
    });
    expect(otherTenantDefault.save).not.toHaveBeenCalled();
    expect(stages).toHaveLength(DEFAULT_PIPELINE_STAGE_DEFINITIONS.length);
  });

  it('reloads and returns the winning opportunity after a duplicate-key race', async () => {
    const lead = new Lead({
      tenantId: 'tenant-1',
      name: 'Ada',
      ownerId: 'rep-1',
      status: 'qualified',
    });
    lead.id = 'lead-1';
    lead.save = vi.fn(async () => undefined);

    const winner = new Opportunity({
      tenantId: 'tenant-1',
      leadId: lead.id,
      pipelineId: 'pipeline-1',
      stageId: 'stage-qualified',
      ownerId: 'rep-1',
      name: 'Ada opportunity',
    });
    winner.id = 'opportunity-1';
    winner.save = vi.fn(async () => undefined);

    const stage = new PipelineStage({
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      key: 'qualified',
      name: 'Qualified',
    });
    stage.id = 'stage-qualified';

    const pipeline = new PipelineDefinition({
      tenantId: 'tenant-1',
      key: 'default',
      name: 'Default Pipeline',
      isDefault: true,
    });
    pipeline.id = 'pipeline-1';

    const getByLeadId = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const createActivity = vi.fn();
    const stores = {
      leads: { get: vi.fn(async () => lead) },
      opportunities: {
        getByLeadId,
        create: vi.fn(async () => {
          throw {
            code: 'VALIDATION_UNIQUE_CONSTRAINT',
            message:
              'duplicate key value violates unique constraint "sales_opportunities_tenant_id_lead_id_idx"',
          };
        }),
      },
      pipelines: {
        get: vi.fn(async () => pipeline),
      },
      stages: {
        findByKey: vi.fn(async () => stage),
        get: vi.fn(async () => stage),
      },
      activities: { create: createActivity },
      leadMerges: {},
    } as unknown as SalesServiceOptions;

    const result = await new SalesService(stores).convertLeadToOpportunity({
      leadId: lead.id,
      pipelineId: 'pipeline-1',
      stageKey: 'qualified',
    });

    expect(result).toEqual({
      opportunityId: 'opportunity-1',
      leadId: 'lead-1',
      created: false,
      stageKey: 'qualified',
    });
    expect(getByLeadId).toHaveBeenCalledTimes(2);
    expect(lead.save).not.toHaveBeenCalled();
    expect(createActivity).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied pipeline ids from a different tenant during conversion', async () => {
    const lead = new Lead({
      tenantId: 'tenant-1',
      name: 'Ada',
      status: 'qualified',
    });
    lead.id = 'lead-1';

    const foreignPipeline = new PipelineDefinition({
      tenantId: 'tenant-2',
      key: 'default',
      name: 'Foreign Pipeline',
      isDefault: true,
    });
    foreignPipeline.id = 'pipeline-foreign';

    const stores = {
      leads: { get: vi.fn(async () => lead) },
      opportunities: {
        getByLeadId: vi.fn(async () => null),
        create: vi.fn(),
      },
      pipelines: {
        get: vi.fn(async () => foreignPipeline),
      },
      stages: {
        findByKey: vi.fn(),
      },
      activities: { create: vi.fn() },
      leadMerges: {},
    } as unknown as SalesServiceOptions;

    await expect(
      new SalesService(stores).convertLeadToOpportunity({
        leadId: lead.id,
        pipelineId: foreignPipeline.id,
        stageKey: 'qualified',
      }),
    ).rejects.toThrow(
      "Pipeline 'pipeline-foreign' does not belong to tenant 'tenant-1'",
    );

    expect(stores.stages.findByKey).not.toHaveBeenCalled();
    expect(stores.opportunities.create).not.toHaveBeenCalled();
  });

  it('reloads the winning default pipeline and stage after duplicate-key bootstrap races', async () => {
    const winnerPipeline = new PipelineDefinition({
      tenantId: 'tenant-1',
      key: 'default',
      name: 'Default Sales Pipeline',
      isDefault: true,
    });
    winnerPipeline.id = 'pipeline-1';
    winnerPipeline.save = vi.fn(async () => undefined);

    const seededStages = new Map<string, PipelineStage>();
    const duplicateStageKeys = new Set(['new']);
    let getDefaultCalls = 0;

    const stores = {
      leads: {},
      opportunities: {},
      pipelines: {
        getDefault: vi.fn(async () => {
          getDefaultCalls += 1;
          return getDefaultCalls === 1 ? null : winnerPipeline;
        }),
        get: vi.fn(async ({ id }: { id: string }) =>
          id === winnerPipeline.id ? winnerPipeline : null,
        ),
        list: vi.fn(async () => [winnerPipeline]),
        create: vi.fn(async (data) => {
          const pipeline = new PipelineDefinition(data);
          pipeline.id = 'pipeline-racing';
          pipeline.save = vi.fn(async () => {
            throw {
              code: '23505',
              message:
                'duplicate key value violates unique constraint "sales_pipelines_tenant_id_key_idx"',
            };
          });
          return pipeline;
        }),
      },
      stages: {
        findByKey: vi.fn(async (pipelineId: string, key: string) => {
          const stage = seededStages.get(`${pipelineId}:${key}`) ?? null;
          return stage;
        }),
        create: vi.fn(async (data) => {
          const stage = new PipelineStage(data);
          stage.id = `stage-${data.key}`;
          stage.save = vi.fn(async () => {
            if (duplicateStageKeys.delete(data.key)) {
              const winner = new PipelineStage(data);
              winner.id = `winner-${data.key}`;
              winner.save = vi.fn(async () => undefined);
              seededStages.set(`${data.pipelineId}:${data.key}`, winner);
              throw {
                code: 'VALIDATION_UNIQUE_CONSTRAINT',
                message:
                  'duplicate key value violates unique constraint "sales_pipeline_stages_tenant_id_pipeline_id_key_idx"',
              };
            }
            seededStages.set(`${data.pipelineId}:${data.key}`, stage);
          });
          return stage;
        }),
      },
      activities: {},
      leadMerges: {},
    } as unknown as SalesServiceOptions;

    const result = await new SalesService(stores).ensureDefaultPipeline(
      'tenant-1',
    );

    expect(result.pipeline).toEqual({
      id: 'pipeline-1',
      key: 'default',
      name: 'Default Sales Pipeline',
    });
    expect(result.stageIdsByKey.new).toBe('winner-new');
    expect(result.stageIdsByKey.qualified).toBe('stage-qualified');
    expect(Object.keys(result.stageIdsByKey)).toHaveLength(
      DEFAULT_PIPELINE_STAGE_DEFINITIONS.length,
    );
    expect(stores.pipelines.getDefault).toHaveBeenCalledTimes(2);
    expect(stores.stages.findByKey).toHaveBeenCalledWith('pipeline-1', 'new');
  });

  it('preserves the full source opportunity snapshot and opportunity-only activities when merging leads', async () => {
    const source = new Lead({
      tenantId: 'tenant-1',
      name: 'Source Lead',
      email: 'source@example.com',
      organization: 'Source Org',
      ownerId: 'rep-1',
      status: 'qualified',
      qualificationSummary: 'Budget confirmed',
      qualifiedAt: new Date('2026-07-01T10:00:00Z'),
      qualifiedById: 'rep-2',
    });
    source.id = 'lead-source';
    source.save = vi.fn(async () => undefined);
    source.recordAcquisition({
      source: 'webinar',
      occurredAt: '2026-06-30T09:00:00Z',
    });

    const target = new Lead({
      tenantId: 'tenant-1',
      name: 'Target Lead',
      email: 'target@example.com',
      organization: 'Target Org',
      status: 'new',
    });
    target.id = 'lead-target';
    target.save = vi.fn(async () => undefined);

    const opportunity = new Opportunity({
      tenantId: 'tenant-1',
      leadId: source.id,
      pipelineId: 'pipeline-1',
      stageId: 'stage-proposal',
      ownerId: 'rep-1',
      name: 'Source Opportunity',
      expectedValue: 4200.0,
      currency: 'CAD',
      nextAction: 'Send proposal',
      outcome: 'open',
      lastStageChangeAt: new Date('2026-07-02T12:00:00Z'),
    });
    opportunity.id = 'opp-1';

    const leadActivity = new SalesActivity({
      tenantId: 'tenant-1',
      leadId: source.id,
      opportunityId: opportunity.id,
      type: 'note',
      actorId: 'rep-1',
      summary: 'Initial qualification notes',
      occurredAt: new Date('2026-07-01T11:00:00Z'),
    });
    leadActivity.id = 'activity-1';
    leadActivity.setDetails({ channel: 'call' });

    const opportunityOnlyActivity = new SalesActivity({
      tenantId: 'tenant-1',
      leadId: null,
      opportunityId: opportunity.id,
      type: 'meeting',
      actorId: 'rep-3',
      summary: 'Proposal walkthrough',
      occurredAt: new Date('2026-07-03T15:00:00Z'),
    });
    opportunityOnlyActivity.id = 'activity-2';
    opportunityOnlyActivity.setDetails({ attendees: 3 });

    let savedMerge: LeadMerge | null = null;
    const stores = {
      leads: {
        get: vi.fn(async ({ id }: { id: string }) =>
          id === source.id ? source : target,
        ),
      },
      opportunities: { getByLeadId: vi.fn(async () => opportunity) },
      pipelines: {},
      stages: {},
      activities: {
        forLead: vi.fn(async () => [leadActivity]),
        forOpportunity: vi.fn(async () => [
          leadActivity,
          opportunityOnlyActivity,
        ]),
        create: vi.fn(async (data) => {
          const activity = new SalesActivity(data);
          activity.id = 'activity-merge';
          activity.save = vi.fn(async () => undefined);
          return activity;
        }),
      },
      leadMerges: {
        findBySourceLeadId: vi.fn(async () => null),
        create: vi.fn(async (data) => {
          const merge = new LeadMerge(data);
          merge.id = 'merge-1';
          merge.save = vi.fn(async () => undefined);
          savedMerge = merge;
          return merge;
        }),
      },
    } as unknown as SalesServiceOptions;

    const result = await new SalesService(stores).mergeLeads({
      sourceLeadId: source.id,
      targetLeadId: target.id,
      actorId: 'rep-9',
    });

    expect(result).toEqual({
      mergeId: 'merge-1',
      sourceLeadId: 'lead-source',
      targetLeadId: 'lead-target',
      created: true,
    });
    const snapshot = savedMerge?.getSourceSnapshot();
    expect(snapshot?.sourceOpportunityId).toBe('opp-1');
    expect(snapshot?.sourceOpportunity).toEqual({
      id: 'opp-1',
      tenantId: 'tenant-1',
      leadId: 'lead-source',
      pipelineId: 'pipeline-1',
      stageId: 'stage-proposal',
      ownerId: 'rep-1',
      name: 'Source Opportunity',
      expectedValue: 4200,
      currency: 'CAD',
      nextAction: 'Send proposal',
      outcome: 'open',
      closedAt: null,
      lastStageChangeAt: '2026-07-02T12:00:00.000Z',
    });
    expect(snapshot?.sourceActivities).toHaveLength(2);
    expect(snapshot?.sourceActivities.map((activity) => activity.id)).toEqual([
      'activity-1',
      'activity-2',
    ]);
    expect(
      snapshot?.sourceActivities.find(
        (activity) => activity.id === 'activity-2',
      ),
    ).toMatchObject({
      type: 'meeting',
      summary: 'Proposal walkthrough',
      opportunityId: 'opp-1',
      details: { attendees: 3 },
    });
  });
});
