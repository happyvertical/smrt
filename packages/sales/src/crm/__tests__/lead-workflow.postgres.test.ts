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

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
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

  it('blocks a second completion session until the first row lock commits', async () => {
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
    // `acquireSession` capability. Pause the first session after it acquires
    // the Lead row lock, then prove the second session is blocked by that
    // backend before allowing the first transaction to continue.
    const originalTransaction = db.transaction.bind(db);
    let transactionIndex = 0;
    let firstBackendPid = 0;
    let secondBackendPid = 0;
    let releaseFirstLock!: () => void;
    const holdFirstLock = new Promise<void>((resolve) => {
      releaseFirstLock = resolve;
    });
    let markFirstLockAcquired!: () => void;
    const firstLockAcquired = new Promise<void>((resolve) => {
      markFirstLockAcquired = resolve;
    });
    let markSecondLockAttempted!: () => void;
    const secondLockAttempted = new Promise<void>((resolve) => {
      markSecondLockAttempted = resolve;
    });

    db.transaction = async (callback) => {
      const currentTransaction = transactionIndex;
      transactionIndex += 1;
      return await originalTransaction(async (tx) => {
        const query = tx.query.bind(tx);
        const backendPid = Number(
          rowsOf(await query('SELECT pg_backend_pid() AS backend_pid'))[0]
            ?.backend_pid,
        );
        if (!Number.isInteger(backendPid) || backendPid <= 0) {
          throw new Error('Expected a PostgreSQL backend pid');
        }
        if (currentTransaction === 0) firstBackendPid = backendPid;
        if (currentTransaction === 1) secondBackendPid = backendPid;

        let firstLockPaused = false;
        const tracked = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === 'query') {
              return async (
                ...args: Parameters<DatabaseInterface['query']>
              ) => {
                const isRowLock = /FOR UPDATE/u.test(String(args[0]));
                if (currentTransaction === 1 && isRowLock) {
                  markSecondLockAttempted();
                }
                const result = await query(...args);
                if (currentTransaction === 0 && isRowLock && !firstLockPaused) {
                  firstLockPaused = true;
                  markFirstLockAcquired();
                  await holdFirstLock;
                }
                return result;
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }) as DatabaseInterface;
        return await callback(tracked);
      });
    };

    const complete = async () => {
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

    let barrierTimedOut = false;
    const barrierTimeout = setTimeout(() => {
      barrierTimedOut = true;
      markFirstLockAcquired();
      markSecondLockAttempted();
      releaseFirstLock();
    }, 5_000);
    let firstCompletion: ReturnType<typeof complete> | undefined;
    let secondCompletion: ReturnType<typeof complete> | undefined;
    try {
      firstCompletion = complete();
      await firstLockAcquired;
      secondCompletion = complete();
      await secondLockAttempted;

      let blockingPids: number[] = [];
      const waitDeadline = Date.now() + 3_000;
      while (blockingPids.length === 0 && Date.now() < waitDeadline) {
        const blockingRows = rowsOf(
          await db.query(
            'SELECT pg_blocking_pids($1::integer) AS blocking_pids',
            secondBackendPid,
          ),
        );
        const value = blockingRows[0]?.blocking_pids;
        blockingPids = Array.isArray(value) ? value.map(Number) : [];
        if (blockingPids.length === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }

      releaseFirstLock();
      const results = await Promise.all([firstCompletion, secondCompletion]);
      expect(barrierTimedOut).toBe(false);
      expect(firstBackendPid).toBeGreaterThan(0);
      expect(secondBackendPid).toBeGreaterThan(0);
      expect(secondBackendPid).not.toBe(firstBackendPid);
      expect(blockingPids).toContain(firstBackendPid);
      expect(results.map((result) => result.completed).sort()).toEqual([
        false,
        true,
      ]);
      expect(results[0].task.id).toBe(results[1].task.id);
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
        expect(
          await activities.findOpenTasks('lead', lead.id as string),
        ).toEqual([]);
      });
    } finally {
      releaseFirstLock();
      clearTimeout(barrierTimeout);
      await Promise.allSettled(
        [firstCompletion, secondCompletion].filter(
          (completion): completion is ReturnType<typeof complete> =>
            completion !== undefined,
        ),
      );
    }
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

  it('fails closed on malformed workflow UUIDs before PostgreSQL casts', async () => {
    const tenantId = randomUUID();
    const lead = await createLead(tenantId);
    const representative = await createRepresentative(tenantId);
    const workflow = await LeadWorkflowService.create({ db });
    const actorProfileId = randomUUID();
    const task = await withTenant({ tenantId }, () =>
      workflow.scheduleNextAction({
        leadId: lead.id as string,
        actorProfileId,
        summary: 'Validate identifier boundary',
        dueAt: new Date('2026-09-06T12:00:00.000Z'),
      }),
    );

    await expect(
      withTenant({ tenantId }, () =>
        workflow.completeNextAction({
          leadId: 'not-a-uuid',
          taskId: task.id as string,
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'lead_unavailable' });
    await expect(
      withTenant({ tenantId }, () =>
        workflow.completeNextAction({
          leadId: lead.id as string,
          taskId: 'not-a-uuid',
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'task_unavailable' });
    await expect(
      withTenant({ tenantId }, () => workflow.getLeadTimeline('not-a-uuid')),
    ).rejects.toMatchObject({ reason: 'lead_unavailable' });
    await expect(
      withTenant({ tenantId }, () =>
        workflow.getLeadWorkState({ leadId: 'not-a-uuid' }),
      ),
    ).rejects.toMatchObject({ reason: 'lead_unavailable' });
    await expect(
      withTenant({ tenantId }, () =>
        workflow.assignLead({
          leadId: lead.id as string,
          ownerRepId: 'not-a-uuid',
          actorProfileId,
        }),
      ),
    ).rejects.toMatchObject({ reason: 'representative_unavailable' });
    await withTenant({ tenantId }, () =>
      workflow.assignLead({
        leadId: lead.id as string,
        ownerRepId: representative.id as string,
        actorProfileId,
      }),
    );
    await expect(
      withTenant({ tenantId }, () =>
        workflow.assignLead({
          leadId: lead.id as string,
          ownerRepId: representative.id as string,
          actorProfileId: 'not-a-uuid',
        }),
      ),
    ).rejects.toMatchObject({ reason: 'invalid_metadata' });
    await withTenant({ tenantId }, async () => {
      expect((await leads.get({ id: lead.id }))?.ownerRepId).toBe(
        representative.id,
      );
      expect(
        await activities.findOpenTasks('lead', lead.id as string),
      ).toHaveLength(1);
    });
  });
});
