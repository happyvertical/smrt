/** PostgreSQL proofs for atomic, tenant-safe Lead follow-up workflow. */

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
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';
import { SalesRepresentativeCollection } from '../collections/SalesRepresentativeCollection.js';
import { LeadWorkflowService } from '../services/LeadWorkflowService.js';

interface TransactionDatabase extends DatabaseInterface {
  transaction<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('LeadWorkflowService on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: TransactionDatabase;
  let leads: LeadCollection;
  let activities: SalesActivityCollection;
  let representatives: SalesRepresentativeCollection;

  beforeEach(async () => {
    enableTenancy();
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Lead', 'SalesActivity', 'SalesRepresentative'],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.baseDb as TransactionDatabase;
    if (typeof db.transaction !== 'function') {
      throw new Error('PostgreSQL test database must expose transaction()');
    }
    leads = await LeadCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
    representatives = await SalesRepresentativeCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function createLead(tenantId: string, name = 'PostgreSQL workflow') {
    return await withTenant({ tenantId }, () =>
      leads.create({ name, slug: randomUUID() }),
    );
  }

  async function createRepresentative(tenantId: string) {
    return await withTenant({ tenantId }, () =>
      representatives.create({
        tenantId,
        profileId: randomUUID(),
        slug: randomUUID(),
        status: 'active',
      }),
    );
  }

  it('rolls back the owner mutation when assignment audit persistence fails', async () => {
    const tenantId = randomUUID();
    const lead = await createLead(tenantId);
    const representative = await createRepresentative(tenantId);
    const workflow = await LeadWorkflowService.create({ db });
    await db.query(`
      CREATE FUNCTION fail_lead_assignment_audit() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected lead assignment audit failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await db.query(`
      CREATE TRIGGER fail_lead_assignment_audit_trigger
      BEFORE INSERT ON sales_activities
      FOR EACH ROW WHEN (NEW.activity_kind = 'assignment')
      EXECUTE FUNCTION fail_lead_assignment_audit()
    `);

    await expect(
      withTenant({ tenantId }, () =>
        workflow.assignLead({
          leadId: lead.id as string,
          ownerRepId: representative.id as string,
          actorProfileId: randomUUID(),
        }),
      ),
    ).rejects.toThrow();

    expect(
      (await withTenant({ tenantId }, () => leads.get({ id: lead.id })))
        ?.ownerRepId,
    ).toBeNull();
    await withTenant({ tenantId }, async () => {
      expect(await activities.findBySubject('lead', lead.id as string)).toEqual(
        [],
      );
    });
    await db.query(
      'DROP TRIGGER fail_lead_assignment_audit_trigger ON sales_activities',
    );
    await db.query('DROP FUNCTION fail_lead_assignment_audit()');
  });

  it('locks concurrent completion to one effective task-completion audit and one exact replay', async () => {
    const tenantId = randomUUID();
    const actorProfileId = randomUUID();
    const lead = await createLead(tenantId);
    const scheduler = await LeadWorkflowService.create({ db });
    const task = await withTenant({ tenantId }, () =>
      scheduler.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId,
        summary: 'PostgreSQL concurrent task',
        dueAt: new Date('2026-09-04T12:00:00.000Z'),
      }),
    );

    // PostgreSQL transaction callback views intentionally omit the pool's
    // `acquireSession` capability. Record their queries to prove the workflow
    // retains the outer adapter classification and still locks both rows.
    const originalTransaction = db.transaction.bind(db);
    const transactionQueries: string[] = [];
    db.transaction = async (callback) =>
      await originalTransaction(async (tx) => {
        const query = tx.query.bind(tx);
        const tracked = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === 'query') {
              return async (
                ...args: Parameters<DatabaseInterface['query']>
              ) => {
                transactionQueries.push(String(args[0]));
                return await query(...args);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }) as DatabaseInterface;
        return await callback(tracked);
      });

    let ready = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = async () => {
      ready += 1;
      if (ready === 2) release();
      await gate;
      const workflow = await LeadWorkflowService.create({ db });
      return await withTenant({ tenantId }, () =>
        workflow.completeNextAction({
          leadId: lead.id as string,
          taskId: task.id as string,
          actorProfileId,
          now: new Date('2026-09-04T13:00:00.000Z'),
        }),
      );
    };

    const results = await Promise.all([complete(), complete()]);
    expect(results.map((result) => result.completed).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0].task.id).toBe(results[1].task.id);
    expect(
      transactionQueries.filter((query) => /FOR UPDATE/u.test(query)),
    ).toHaveLength(4);
    await withTenant({ tenantId }, async () => {
      const timeline = await activities.findBySubject(
        'lead',
        lead.id as string,
      );
      expect(
        timeline.filter(
          (activity) => activity.activityKind === 'task_completion',
        ),
      ).toHaveLength(1);
      expect(await activities.findOpenTasks('lead', lead.id as string)).toEqual(
        [],
      );
    });
  });

  it('fails closed on a foreign Lead identifier without exposing its task or timeline', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const lead = await createLead(tenantA);
    const workflowA = await LeadWorkflowService.create({ db });
    const task = await withTenant({ tenantId: tenantA }, () =>
      workflowA.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId: randomUUID(),
        summary: 'Tenant A action',
        dueAt: new Date('2026-09-05T12:00:00.000Z'),
      }),
    );
    const workflowB = await LeadWorkflowService.create({ db });

    await expect(
      withTenant({ tenantId: tenantB }, () =>
        workflowB.completeNextAction({
          leadId: lead.id as string,
          taskId: task.id as string,
          actorProfileId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ reason: 'lead_unavailable' });
    await expect(
      withTenant({ tenantId: tenantB }, () =>
        workflowB.getLeadTimeline(lead.id as string),
      ),
    ).rejects.toMatchObject({ reason: 'lead_unavailable' });
    await withTenant({ tenantId: tenantA }, async () => {
      expect(
        await activities.findOpenTasks('lead', lead.id as string),
      ).toHaveLength(1);
    });
  });
});
