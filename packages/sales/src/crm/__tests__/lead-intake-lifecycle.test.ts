import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { OpportunityCollection } from '../collections/OpportunityCollection.js';
import { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import { PipelineStageCollection } from '../collections/PipelineStageCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import {
  LeadWorkflowService,
  type LeadWorkflowValidationError,
} from '../services/LeadWorkflowService.js';

describe('Lead intake and conversion lifecycle', () => {
  let db: DatabaseInterface;
  let service: LeadWorkflowService;
  let leads: LeadCollection;
  let opportunities: OpportunityCollection;
  let pipelines: PipelineDefinitionCollection;
  let stages: PipelineStageCollection;
  let activities: SalesActivityCollection;
  let representatives: SalesRepresentativeCollection;
  let tenantId: string;
  let actorProfileId: string;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase();
    service = await LeadWorkflowService.create({ db });
    leads = await LeadCollection.create({ db });
    opportunities = await OpportunityCollection.create({ db });
    pipelines = await PipelineDefinitionCollection.create({ db });
    stages = await PipelineStageCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
    representatives = await SalesRepresentativeCollection.create({ db });
    tenantId = randomUUID();
    actorProfileId = randomUUID();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    withTenant({ tenantId }, fn);

  const intake = (overrides: Record<string, unknown> = {}) =>
    run(() =>
      service.createLead({
        name: '  Acme Retrofit  ',
        email: ' Sales@ACME.Test ',
        sourceKind: 'contact_form',
        actorProfileId,
        ...overrides,
      }),
    );

  it('validates required input and normalizes email before an atomic audited create', async () => {
    for (const [input, reason] of [
      [{ name: '', email: 'a@b.test', sourceKind: 'form' }, 'name_required'],
      [{ name: 'A', sourceKind: 'form' }, 'contact_required'],
      [
        { name: 'A', email: 'not-an-email', sourceKind: 'form' },
        'invalid_email',
      ],
      [{ name: 'A', phone: '555', sourceKind: '' }, 'source_kind_required'],
    ] as const) {
      await expect(run(() => service.createLead(input))).rejects.toMatchObject<
        Partial<LeadWorkflowValidationError>
      >({ reason });
    }

    const result = await intake({
      phone: ' 555-0100 ',
      acquisitionContext: { campaign: 'fall' },
    });
    expect(result.created).toBe(true);
    expect(result.lead).toMatchObject({
      name: 'Acme Retrofit',
      email: 'sales@acme.test',
      phone: '555-0100',
      tenantId,
    });
    expect(result.lead.getAcquisitionContext()).toEqual({ campaign: 'fall' });
    const audit = await run(() =>
      activities.findBySubject('lead', result.lead.id as string),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      activityKind: 'lead_intake',
      actorProfileId,
    });
  });

  it('persists retry identity, rejects changed intent, and emits one inbound audit per novel active-email intake', async () => {
    const first = await intake({ idempotencyKey: 'submission-1' });
    const retry = await intake({ idempotencyKey: 'submission-1' });
    expect(retry).toMatchObject({ created: false });
    expect(retry.lead.id).toBe(first.lead.id);

    await expect(
      intake({ idempotencyKey: 'submission-1', name: 'Changed intent' }),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'idempotency_conflict',
    });

    const novel = await intake({ sourceId: 'submission-2' });
    const novelRetry = await intake({ sourceId: 'submission-2' });
    expect(novel.created).toBe(false);
    expect(novel.lead.id).toBe(first.lead.id);
    expect(novelRetry.lead.id).toBe(first.lead.id);
    const audit = await run(() =>
      activities.findBySubject('lead', first.lead.id as string),
    );
    expect(audit.map((row) => row.activityKind)).toEqual([
      'lead_intake',
      'inbound',
    ]);
  });

  it('reports terminal duplicates without mutation and honors none/email_or_org policies', async () => {
    const terminal = await run(() =>
      leads.create({
        name: 'Old Acme',
        email: 'old@acme.test',
        organizationName: 'Acme',
        status: 'disqualified',
      }),
    );
    const reported = await intake({
      email: 'old@acme.test',
      organizationName: 'Acme',
      dedupe: 'email_or_org',
    });
    expect(reported).toMatchObject({ created: false });
    expect(reported.lead.id).toBe(terminal.id);
    expect(reported.duplicateOf?.id).toBe(terminal.id);
    expect(
      await run(() => activities.findBySubject('lead', terminal.id as string)),
    ).toEqual([]);

    const forced = await intake({
      email: 'old@acme.test',
      organizationName: 'Acme',
      dedupe: 'none',
    });
    expect(forced.created).toBe(true);
    expect(forced.lead.id).not.toBe(terminal.id);
  });

  it('never dedupes or resolves ids across tenants', async () => {
    const first = await intake({ idempotencyKey: 'shared-key' });
    const foreignTenant = randomUUID();
    const foreign = await withTenant({ tenantId: foreignTenant }, () =>
      service.createLead({
        name: 'Foreign Acme',
        email: 'sales@acme.test',
        sourceKind: 'contact_form',
        idempotencyKey: 'shared-key',
      }),
    );
    expect(foreign.created).toBe(true);
    expect(foreign.lead.id).not.toBe(first.lead.id);
    await expect(
      withTenant({ tenantId: foreignTenant }, () =>
        service.qualifyLead({
          leadId: first.lead.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'lead_unavailable',
    });
  });

  it('accepts only active same-tenant owners during intake', async () => {
    const active = await run(() =>
      representatives.create({
        profileId: randomUUID(),
        status: 'active',
      }),
    );
    const inactive = await run(() =>
      representatives.create({
        profileId: randomUUID(),
        status: 'inactive',
      }),
    );
    const foreign = await withTenant({ tenantId: randomUUID() }, () =>
      representatives.create({
        profileId: randomUUID(),
        status: 'active',
      }),
    );

    expect(
      (await intake({ email: 'owned@acme.test', ownerRepId: active.id })).lead
        .ownerRepId,
    ).toBe(active.id);
    await expect(
      intake({ email: 'inactive@acme.test', ownerRepId: inactive.id }),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'representative_inactive',
    });
    await expect(
      intake({ email: 'foreign@acme.test', ownerRepId: foreign.id }),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'representative_unavailable',
    });
  });

  it('qualifies through the collection with actor audits and exposes the linked opportunity', async () => {
    const created = await intake();
    const qualified = await run(() =>
      service.qualifyLead({
        leadId: created.lead.id as string,
        actorProfileId,
        expectedValueCents: 125_00,
      }),
    );
    const retry = await run(() =>
      service.qualifyLead({
        leadId: created.lead.id as string,
        actorProfileId,
      }),
    );
    expect(qualified.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.opportunity.id).toBe(qualified.opportunity.id);
    expect(
      (
        await run(() =>
          service.getLeadWorkState({ leadId: created.lead.id as string }),
        )
      ).opportunity?.id,
    ).toBe(qualified.opportunity.id);
    const leadAudit = await run(() =>
      activities.findBySubject('lead', created.lead.id as string),
    );
    expect(
      leadAudit.filter((row) => row.activityKind === 'qualification'),
    ).toEqual([expect.objectContaining({ actorProfileId })]);
  });

  it('closes won/lost at configured terminal stages and idempotently records conversion', async () => {
    const wonLead = await intake({ email: 'won@acme.test' });
    const wonQualified = await run(() =>
      service.qualifyLead({
        leadId: wonLead.lead.id as string,
        actorProfileId,
      }),
    );
    const won = await run(() =>
      service.closeOpportunity({
        opportunityId: wonQualified.opportunity.id as string,
        outcome: 'won',
        actorProfileId,
        reason: 'accepted',
        conversion: { targetKind: 'client', targetId: 'client-1' },
      }),
    );
    const wonRetry = await run(() =>
      service.closeOpportunity({
        opportunityId: wonQualified.opportunity.id as string,
        outcome: 'won',
        actorProfileId,
        reason: 'accepted',
        conversion: { targetKind: 'client', targetId: 'client-1' },
      }),
    );
    expect(won).toMatchObject({ changed: true, conversionCreated: true });
    expect(won.opportunity.status).toBe('won');
    expect(wonRetry).toMatchObject({
      changed: false,
      conversionCreated: false,
    });
    expect(wonRetry.conversion?.id).toBe(won.conversion?.id);

    const lostLead = await intake({ email: 'lost@acme.test' });
    const lostQualified = await run(() =>
      service.qualifyLead({
        leadId: lostLead.lead.id as string,
        actorProfileId,
      }),
    );
    const lost = await run(() =>
      service.closeOpportunity({
        opportunityId: lostQualified.opportunity.id as string,
        outcome: 'lost',
        actorProfileId,
        reason: 'budget',
      }),
    );
    expect(lost.opportunity).toMatchObject({
      status: 'lost',
      outcomeReason: 'budget',
    });
    await expect(
      run(() =>
        service.closeOpportunity({
          opportunityId: lostQualified.opportunity.id as string,
          outcome: 'won',
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'opportunity_replay_conflict',
    });

    const wonWithoutConversionLead = await intake({
      email: 'won-without-conversion@acme.test',
    });
    const wonWithoutConversionQualified = await run(() =>
      service.qualifyLead({
        leadId: wonWithoutConversionLead.lead.id as string,
        actorProfileId,
      }),
    );
    const wonWithoutConversion = await run(() =>
      service.closeOpportunity({
        opportunityId: wonWithoutConversionQualified.opportunity.id as string,
        outcome: 'won',
        actorProfileId,
      }),
    );
    expect(wonWithoutConversion.opportunity.status).toBe('won');
    expect(wonWithoutConversion.conversion).toBeUndefined();
  });

  it('rolls back intake and close mutations when an audit/conversion write fails', async () => {
    await db.query(`
      CREATE TRIGGER fail_intake_audit BEFORE INSERT ON sales_activities
      WHEN NEW.activity_kind = 'lead_intake'
      BEGIN SELECT RAISE(FAIL, 'injected intake audit failure'); END
    `);
    await expect(intake({ email: 'rollback@acme.test' })).rejects.toThrow(
      'injected intake audit failure',
    );
    await db.query('DROP TRIGGER fail_intake_audit');
    expect(
      await run(() => leads.list({ where: { email: 'rollback@acme.test' } })),
    ).toEqual([]);

    const created = await intake({ email: 'close-rollback@acme.test' });
    const qualified = await run(() =>
      service.qualifyLead({
        leadId: created.lead.id as string,
        actorProfileId,
      }),
    );
    await db.query(`
      CREATE TRIGGER fail_conversion BEFORE INSERT ON opportunity_conversions
      BEGIN SELECT RAISE(FAIL, 'injected conversion failure'); END
    `);
    await expect(
      run(() =>
        service.closeOpportunity({
          opportunityId: qualified.opportunity.id as string,
          outcome: 'won',
          actorProfileId,
          conversion: { targetKind: 'client', targetId: 'rollback' },
        }),
      ),
    ).rejects.toThrow('injected conversion failure');
    expect(
      (
        await run(() =>
          opportunities.get({ id: qualified.opportunity.id }, { cache: false }),
        )
      )?.status,
    ).toBe('open');
  });

  it('rejects a close when the pipeline lacks the requested terminal stage', async () => {
    const pipeline = await run(() =>
      pipelines.create({ key: 'no-win', name: 'No win' }),
    );
    const stage = await run(() =>
      stages.create({
        pipelineId: pipeline.id as string,
        key: 'open',
        name: 'Open',
      }),
    );
    const opportunity = await run(() =>
      opportunities.create({
        name: 'No terminal',
        pipelineId: pipeline.id as string,
        stageId: stage.id as string,
      }),
    );
    await expect(
      run(() =>
        service.closeOpportunity({
          opportunityId: opportunity.id as string,
          outcome: 'won',
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject<Partial<LeadWorkflowValidationError>>({
      reason: 'pipeline_has_no_terminal_stage',
    });
  });
});

describe('Lead intake and conversion lifecycle on DuckDB', () => {
  it('preserves atomic retry, qualification, and won conversion behavior', async () => {
    enableTenancy();
    const db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: [
        'Lead',
        'Opportunity',
        'OpportunityConversion',
        'PipelineDefinition',
        'PipelineStage',
        'SalesActivity',
        'SalesRepresentative',
      ],
      omitForeignKeyConstraints: true,
    });
    const tenantId = randomUUID();
    const actorProfileId = randomUUID();
    try {
      const service = await LeadWorkflowService.create({ db });
      const leads = await LeadCollection.create({ db });
      const first = await withTenant({ tenantId }, () =>
        service.createLead({
          name: 'DuckDB intake',
          email: 'duck@example.test',
          sourceKind: 'form',
          idempotencyKey: 'duck-intake',
        }),
      );
      const replay = await withTenant({ tenantId }, () =>
        service.createLead({
          name: 'DuckDB intake',
          email: 'duck@example.test',
          sourceKind: 'form',
          idempotencyKey: 'duck-intake',
        }),
      );
      expect(replay.created).toBe(false);
      expect(replay.lead.id).toBe(first.lead.id);

      const qualified = await withTenant({ tenantId }, () =>
        service.qualifyLead({
          leadId: first.lead.id as string,
          actorProfileId,
        }),
      );
      const closed = await withTenant({ tenantId }, () =>
        service.closeOpportunity({
          opportunityId: qualified.opportunity.id as string,
          outcome: 'won',
          actorProfileId,
          conversion: { targetKind: 'client', targetId: 'duck-client' },
        }),
      );
      expect(closed).toMatchObject({
        changed: true,
        conversionCreated: true,
      });
      expect(closed.opportunity.status).toBe('won');

      const terminal = await withTenant({ tenantId }, () =>
        leads.create({
          name: 'DuckDB terminal',
          email: 'terminal-duck@example.test',
          organizationName: 'Duck Org',
          status: 'disqualified',
        }),
      );
      const terminalReport = await withTenant({ tenantId }, () =>
        service.createLead({
          name: 'DuckDB terminal retry',
          email: 'TERMINAL-DUCK@example.test',
          organizationName: 'Duck Org',
          sourceKind: 'form',
          dedupe: 'email_or_org',
        }),
      );
      expect(terminalReport).toMatchObject({ created: false });
      expect(terminalReport.duplicateOf?.id).toBe(terminal.id);

      const foreignTenantId = randomUUID();
      const isolatedIdentity = await withTenant(
        { tenantId: foreignTenantId },
        () =>
          service.createLead({
            name: 'DuckDB foreign identity',
            email: 'terminal-duck@example.test',
            organizationName: 'Duck Org',
            sourceKind: 'form',
            dedupe: 'email_or_org',
          }),
      );
      expect(isolatedIdentity.created).toBe(true);
      expect(isolatedIdentity.lead.id).not.toBe(terminal.id);

      const lostLead = await withTenant({ tenantId }, () =>
        service.createLead({
          name: 'DuckDB lost lead',
          email: 'lost-duck@example.test',
          sourceKind: 'form',
        }),
      );
      const lostQualified = await withTenant({ tenantId }, () =>
        service.qualifyLead({
          leadId: lostLead.lead.id as string,
          actorProfileId,
        }),
      );
      const lost = await withTenant({ tenantId }, () =>
        service.closeOpportunity({
          opportunityId: lostQualified.opportunity.id as string,
          outcome: 'lost',
          actorProfileId,
          reason: 'DuckDB loss',
        }),
      );
      expect(lost.opportunity).toMatchObject({
        status: 'lost',
        outcomeReason: 'DuckDB loss',
      });
      expect(lost.conversion).toBeUndefined();
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
});
