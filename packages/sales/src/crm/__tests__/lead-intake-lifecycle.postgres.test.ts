import { randomUUID } from 'node:crypto';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadCollection } from '../collections/LeadCollection.js';
import { OpportunityCollection } from '../collections/OpportunityCollection.js';
import { PipelineDefinitionCollection } from '../collections/PipelineDefinitionCollection.js';
import { PipelineStageCollection } from '../collections/PipelineStageCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import { LeadWorkflowService } from '../services/LeadWorkflowService.js';

interface TransactionDatabase extends DatabaseInterface {
  transaction<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('Lead intake and conversion lifecycle on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: TransactionDatabase;
  let service: LeadWorkflowService;
  let leads: LeadCollection;
  let opportunities: OpportunityCollection;
  let pipelines: PipelineDefinitionCollection;
  let stages: PipelineStageCollection;
  let activities: SalesActivityCollection;
  let tenantId: string;
  let actorProfileId: string;

  beforeEach(async () => {
    enableTenancy();
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Lead',
        'Opportunity',
        'OpportunityConversion',
        'PipelineDefinition',
        'PipelineStage',
        'SalesActivity',
        'SalesRepresentative',
      ],
    });
    db = isolated.baseDb as TransactionDatabase;
    service = await LeadWorkflowService.create({ db });
    leads = await LeadCollection.create({ db });
    opportunities = await OpportunityCollection.create({ db });
    pipelines = await PipelineDefinitionCollection.create({ db });
    stages = await PipelineStageCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
    tenantId = randomUUID();
    actorProfileId = randomUUID();
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('serializes concurrent exact retries with one persisted lead and audit', async () => {
    const profileId = randomUUID();
    const create = () =>
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Concurrent intake',
          email: 'concurrent@example.test',
          sourceKind: 'form',
          idempotencyKey: 'same-submission',
          profileId,
          actorProfileId,
        }),
      );
    const [first, second] = await Promise.all([create(), create()]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.lead.id).toBe(second.lead.id);
    await withTenant({ tenantId }, async () => {
      expect(await leads.list({})).toHaveLength(1);
      expect(
        await activities.findBySubject('lead', first.lead.id as string),
      ).toHaveLength(1);
    });
    await expect(
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Concurrent intake',
          email: 'concurrent@example.test',
          sourceKind: 'form',
          idempotencyKey: 'same-submission',
          profileId: randomUUID(),
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' });
  });

  it('serializes concurrent exact nonterminal stage moves into one audit', async () => {
    const created = await withTenant({ tenantId }, () =>
      service.createLead({
        name: 'Concurrent stage',
        email: 'concurrent-stage@example.test',
        sourceKind: 'form',
      }),
    );
    const qualified = await withTenant({ tenantId }, () =>
      service.qualifyLead({
        leadId: created.lead.id as string,
        actorProfileId,
      }),
    );
    const pipelineStages = await withTenant({ tenantId }, () =>
      pipelines.getStages(qualified.opportunity.pipelineId),
    );
    const target = pipelineStages.find((stage) => stage.key === 'discovery');
    await db.query(`
      CREATE FUNCTION pause_concurrent_stage_move() RETURNS trigger AS $$
      BEGIN
        IF NEW.stage_id = '${target?.id}' THEN PERFORM pg_sleep(0.2); END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.query(`
      CREATE TRIGGER pause_concurrent_stage_move_trigger
      BEFORE UPDATE ON opportunities
      FOR EACH ROW EXECUTE FUNCTION pause_concurrent_stage_move()
    `);
    const move = () =>
      withTenant({ tenantId }, () =>
        service.moveOpportunityToStage({
          opportunityId: qualified.opportunity.id as string,
          stageId: target?.id as string,
          actorProfileId,
        }),
      );
    const [first, second] = await Promise.all([move(), move()]);
    await db.query(
      'DROP TRIGGER pause_concurrent_stage_move_trigger ON opportunities',
    );
    await db.query('DROP FUNCTION pause_concurrent_stage_move()');
    expect([first.changed, second.changed].sort()).toEqual([false, true]);
    expect(first.opportunity.stageId).toBe(target?.id);
    expect(second.opportunity.stageId).toBe(target?.id);
    const audit = await withTenant({ tenantId }, () =>
      activities.findBySubject(
        'opportunity',
        qualified.opportunity.id as string,
      ),
    );
    expect(
      audit.filter((row) => row.activityKind === 'stage_change'),
    ).toHaveLength(1);
  });

  it('keeps a nonterminal move open while a concurrent stage edit becomes terminal', async () => {
    const created = await withTenant({ tenantId }, () =>
      service.createLead({
        name: 'Concurrent stage definition',
        email: 'concurrent-stage-definition@example.test',
        sourceKind: 'form',
      }),
    );
    const qualified = await withTenant({ tenantId }, () =>
      service.qualifyLead({
        leadId: created.lead.id as string,
        actorProfileId,
      }),
    );
    const pipelineStages = await withTenant({ tenantId }, () =>
      pipelines.getStages(qualified.opportunity.pipelineId),
    );
    const target = pipelineStages.find((stage) => stage.key === 'discovery');
    if (!target?.id) throw new Error('discovery stage not found');

    let stageRead!: () => void;
    const firstStageRead = new Promise<void>((resolve) => {
      stageRead = resolve;
    });
    let stageUpdated!: () => void;
    const updateFinished = new Promise<void>((resolve) => {
      stageUpdated = resolve;
    });
    const stagePrototype = PipelineStageCollection.prototype as unknown as {
      get: PipelineStageCollection['get'];
      query: PipelineStageCollection['query'];
    };
    const originalGet = stagePrototype.get;
    const originalQuery = stagePrototype.query;
    let intercepted = false;
    stagePrototype.get = async function (...args) {
      const stage = await originalGet.apply(this, args);
      if (!intercepted && args[0]?.id === target.id) {
        intercepted = true;
        stageRead();
        await updateFinished;
      }
      return stage;
    };
    stagePrototype.query = async function (...args) {
      const rows = await originalQuery.apply(this, args);
      if (
        !intercepted &&
        String(args[0]).includes('FOR UPDATE') &&
        args[1]?.[0] === target.id
      ) {
        intercepted = true;
        stageRead();
      }
      return rows;
    };

    const move = withTenant({ tenantId }, () =>
      service.moveOpportunityToStage({
        opportunityId: qualified.opportunity.id as string,
        stageId: target.id as string,
        actorProfileId,
      }),
    );
    await firstStageRead;
    const update = db
      .query('UPDATE pipeline_stages SET is_won = TRUE WHERE id = $1', [
        target.id,
      ])
      .then(() => stageUpdated());
    const [moved] = await Promise.all([move, update]).finally(() => {
      stagePrototype.get = originalGet;
      stagePrototype.query = originalQuery;
    });

    expect(moved.opportunity).toMatchObject({
      stageId: target.id,
      status: 'open',
    });
  });

  it('rolls back a nonterminal stage move when its audit insert fails', async () => {
    const created = await withTenant({ tenantId }, () =>
      service.createLead({
        name: 'Stage rollback',
        email: 'stage-rollback@example.test',
        sourceKind: 'form',
      }),
    );
    const qualified = await withTenant({ tenantId }, () =>
      service.qualifyLead({
        leadId: created.lead.id as string,
        actorProfileId,
      }),
    );
    const originalStageId = qualified.opportunity.stageId;
    const pipelineStages = await withTenant({ tenantId }, () =>
      pipelines.getStages(qualified.opportunity.pipelineId),
    );
    const target = pipelineStages.find((stage) => stage.key === 'discovery');
    await db.query(`
      CREATE FUNCTION fail_nonterminal_stage_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected stage audit failure'; END;
      $$ LANGUAGE plpgsql
    `);
    await db.query(`
      CREATE TRIGGER fail_nonterminal_stage_audit_trigger
      BEFORE INSERT ON sales_activities
      FOR EACH ROW WHEN (NEW.activity_kind = 'stage_change')
      EXECUTE FUNCTION fail_nonterminal_stage_audit()
    `);
    await expect(
      withTenant({ tenantId }, () =>
        service.moveOpportunityToStage({
          opportunityId: qualified.opportunity.id as string,
          stageId: target?.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toThrow('injected stage audit failure');
    await db.query(
      'DROP TRIGGER fail_nonterminal_stage_audit_trigger ON sales_activities',
    );
    await db.query('DROP FUNCTION fail_nonterminal_stage_audit()');
    expect(
      await withTenant({ tenantId }, () =>
        opportunities.get({ id: qualified.opportunity.id }, { cache: false }),
      ),
    ).toMatchObject({ stageId: originalStageId, status: 'open' });
  });

  it('serializes concurrent intake across overlapping dedupe identities', async () => {
    await db.query(`
      CREATE FUNCTION pause_concurrent_lead_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.name LIKE 'Concurrent dedupe%' THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.query(`
      CREATE TRIGGER pause_concurrent_lead_insert_trigger
      BEFORE INSERT ON leads
      FOR EACH ROW EXECUTE FUNCTION pause_concurrent_lead_insert()
    `);

    const [emailPolicy, emailOrOrgPolicy] = await Promise.all([
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Concurrent dedupe email policy',
          email: 'shared-concurrent@example.test',
          organizationName: 'First Organization',
          sourceKind: 'form',
          dedupe: 'email',
          idempotencyKey: 'concurrent-email-policy',
        }),
      ),
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Concurrent dedupe email or org policy',
          email: ' SHARED-CONCURRENT@example.test ',
          organizationName: 'Second Organization',
          sourceKind: 'form',
          dedupe: 'email_or_org',
          idempotencyKey: 'concurrent-email-or-org-policy',
        }),
      ),
    ]);
    expect([emailPolicy.created, emailOrOrgPolicy.created].sort()).toEqual([
      false,
      true,
    ]);
    expect(emailPolicy.lead.id).toBe(emailOrOrgPolicy.lead.id);

    const [firstOrganization, secondOrganization] = await Promise.all([
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Concurrent dedupe first organization',
          email: 'first-organization@example.test',
          organizationName: 'Shared Organization',
          sourceKind: 'form',
          dedupe: 'email_or_org',
          idempotencyKey: 'concurrent-first-organization',
        }),
      ),
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Concurrent dedupe second organization',
          email: 'second-organization@example.test',
          organizationName: ' SHARED ORGANIZATION ',
          sourceKind: 'form',
          dedupe: 'email_or_org',
          idempotencyKey: 'concurrent-second-organization',
        }),
      ),
    ]);
    expect(
      [firstOrganization.created, secondOrganization.created].sort(),
    ).toEqual([false, true]);
    expect(firstOrganization.lead.id).toBe(secondOrganization.lead.id);
    expect(await withTenant({ tenantId }, () => leads.list({}))).toHaveLength(
      2,
    );
  });

  it('rolls back the won stage move and audit when conversion persistence fails', async () => {
    await db.query(`
      CREATE FUNCTION fail_crm_intake_audit() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected intake audit failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.query(`
      CREATE TRIGGER fail_crm_intake_audit_trigger
      BEFORE INSERT ON sales_activities
      FOR EACH ROW WHEN (NEW.activity_kind = 'lead_intake')
      EXECUTE FUNCTION fail_crm_intake_audit()
    `);
    await expect(
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Rolled back intake',
          email: 'intake-rollback@example.test',
          sourceKind: 'form',
        }),
      ),
    ).rejects.toThrow('injected intake audit failure');
    await db.query(
      'DROP TRIGGER fail_crm_intake_audit_trigger ON sales_activities',
    );
    expect(
      await withTenant({ tenantId }, () =>
        leads.list({ where: { email: 'intake-rollback@example.test' } }),
      ),
    ).toEqual([]);

    const created = await withTenant({ tenantId }, () =>
      service.createLead({
        name: 'Rollback deal',
        email: 'rollback@example.test',
        sourceKind: 'form',
      }),
    );
    const qualified = await withTenant({ tenantId }, () =>
      service.qualifyLead({
        leadId: created.lead.id as string,
        actorProfileId,
      }),
    );
    await db.query(`
      CREATE FUNCTION fail_crm_conversion() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected conversion failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.query(`
      CREATE TRIGGER fail_crm_conversion_trigger
      BEFORE INSERT ON opportunity_conversions
      FOR EACH ROW EXECUTE FUNCTION fail_crm_conversion()
    `);

    await expect(
      withTenant({ tenantId }, () =>
        service.closeOpportunity({
          opportunityId: qualified.opportunity.id as string,
          outcome: 'won',
          actorProfileId,
          conversion: { targetKind: 'client', targetId: 'rollback-client' },
        }),
      ),
    ).rejects.toThrow('injected conversion failure');

    await withTenant({ tenantId }, async () => {
      expect(
        (
          await opportunities.get(
            { id: qualified.opportunity.id },
            { cache: false },
          )
        )?.status,
      ).toBe('open');
      const opportunityAudit = await activities.findBySubject(
        'opportunity',
        qualified.opportunity.id as string,
      );
      expect(
        opportunityAudit.filter((row) => row.activityKind === 'stage_change'),
      ).toEqual([]);
    });

    await db.query(
      'DROP TRIGGER fail_crm_conversion_trigger ON opportunity_conversions',
    );
    const closed = await withTenant({ tenantId }, () =>
      service.closeOpportunity({
        opportunityId: qualified.opportunity.id as string,
        outcome: 'won',
        actorProfileId,
        conversion: { targetKind: 'client', targetId: 'rollback-client' },
      }),
    );
    const replay = await withTenant({ tenantId }, () =>
      service.closeOpportunity({
        opportunityId: qualified.opportunity.id as string,
        outcome: 'won',
        actorProfileId,
        conversion: { targetKind: 'client', targetId: 'rollback-client' },
      }),
    );
    expect(closed).toMatchObject({ changed: true, conversionCreated: true });
    expect(replay).toMatchObject({ changed: false, conversionCreated: false });
    expect(replay.conversion?.id).toBe(closed.conversion?.id);
  });

  it('enforces tenant UUID boundaries, terminal dedupe policy, and lost closure without conversion', async () => {
    const foreignTenantId = randomUUID();
    const representatives = await SalesRepresentativeCollection.create({ db });
    const pipelines = await PipelineDefinitionCollection.create({ db });
    const stages = await PipelineStageCollection.create({ db });
    const foreignOwner = await withTenant({ tenantId: foreignTenantId }, () =>
      representatives.create({
        profileId: randomUUID(),
        status: 'active',
      }),
    );
    await expect(
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Malformed email',
          email: 'not-an-email',
          sourceKind: 'form',
        }),
      ),
    ).rejects.toMatchObject({ reason: 'invalid_email' });
    await expect(
      withTenant({ tenantId }, () =>
        service.createLead({
          name: 'Foreign owner refusal',
          email: 'foreign-owner@example.test',
          sourceKind: 'form',
          ownerRepId: foreignOwner.id as string,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'representative_unavailable' });

    const terminal = await withTenant({ tenantId }, () =>
      leads.create({
        name: 'Terminal duplicate',
        email: 'terminal@example.test',
        organizationName: 'Terminal Org',
        status: 'disqualified',
      }),
    );
    const reported = await withTenant({ tenantId }, () =>
      service.createLead({
        name: 'Repeated terminal intake',
        email: ' TERMINAL@example.test ',
        organizationName: 'Terminal Org',
        sourceKind: 'form',
        dedupe: 'email_or_org',
      }),
    );
    expect(reported).toMatchObject({ created: false });
    expect(reported.lead.id).toBe(terminal.id);
    expect(reported.duplicateOf?.id).toBe(terminal.id);
    expect(
      await withTenant({ tenantId }, () =>
        activities.findBySubject('lead', terminal.id as string),
      ),
    ).toEqual([]);

    const foreignSameIdentity = await withTenant(
      { tenantId: foreignTenantId },
      () =>
        service.createLead({
          name: 'Foreign terminal identity',
          email: 'terminal@example.test',
          organizationName: 'Terminal Org',
          sourceKind: 'form',
          dedupe: 'email_or_org',
        }),
    );
    expect(foreignSameIdentity.created).toBe(true);
    expect(foreignSameIdentity.lead.id).not.toBe(terminal.id);

    const foreignPipeline = await withTenant(
      { tenantId: foreignTenantId },
      () => pipelines.create({ key: 'foreign', name: 'Foreign pipeline' }),
    );
    const local = await withTenant({ tenantId }, () =>
      service.createLead({
        name: 'Local qualification',
        email: 'local@example.test',
        sourceKind: 'form',
      }),
    );
    await expect(
      withTenant({ tenantId }, () =>
        service.qualifyLead({
          leadId: local.lead.id as string,
          pipelineId: foreignPipeline.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'pipeline_unavailable' });
    await expect(
      withTenant({ tenantId: foreignTenantId }, () =>
        service.qualifyLead({
          leadId: local.lead.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'lead_unavailable' });

    const qualified = await withTenant({ tenantId }, () =>
      service.qualifyLead({
        leadId: local.lead.id as string,
        actorProfileId,
      }),
    );
    const workState = await withTenant({ tenantId }, () =>
      service.getLeadWorkState({ leadId: local.lead.id as string }),
    );
    expect(workState.opportunity?.id).toBe(qualified.opportunity.id);
    const leadAudit = await withTenant({ tenantId }, () =>
      activities.findBySubject('lead', local.lead.id as string),
    );
    expect(
      leadAudit.filter((row) => row.activityKind === 'qualification'),
    ).toEqual([expect.objectContaining({ actorProfileId })]);
    await expect(
      withTenant({ tenantId: foreignTenantId }, () =>
        service.closeOpportunity({
          opportunityId: qualified.opportunity.id as string,
          outcome: 'lost',
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'opportunity_unavailable' });

    const lost = await withTenant({ tenantId }, () =>
      service.closeOpportunity({
        opportunityId: qualified.opportunity.id as string,
        outcome: 'lost',
        actorProfileId,
        reason: 'not proceeding',
      }),
    );
    expect(lost.opportunity).toMatchObject({
      status: 'lost',
      outcomeReason: 'not proceeding',
    });
    expect(lost.conversion).toBeUndefined();

    const noTerminalPipeline = await withTenant({ tenantId }, () =>
      pipelines.create({ key: 'no-terminal', name: 'No terminal' }),
    );
    const openStage = await withTenant({ tenantId }, () =>
      stages.create({
        pipelineId: noTerminalPipeline.id as string,
        key: 'open',
        name: 'Open',
      }),
    );
    const noTerminalOpportunity = await withTenant({ tenantId }, () =>
      opportunities.create({
        name: 'No terminal opportunity',
        pipelineId: noTerminalPipeline.id as string,
        stageId: openStage.id as string,
      }),
    );
    await expect(
      withTenant({ tenantId }, () =>
        service.closeOpportunity({
          opportunityId: noTerminalOpportunity.id as string,
          outcome: 'won',
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'pipeline_has_no_terminal_stage' });
  });
});
