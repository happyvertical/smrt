/**
 * A run opened with a parent or a retry source stays inside its own tenant
 * (docs/content/ai-runs.md section 2): `openAiRun` treats a referenced run of
 * another tenant, or of the global scope, as a run that is not there, before
 * it reads that run's status, definition or checkpoint. Real SQLite and
 * DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiRunNotFoundError,
  AiRunResumeRefusedError,
  cancelAiRun,
  finishAiRun,
  getAiRun,
  getRunTrajectory,
  openAiRun,
  readAiRunCheckpoint,
  reserveAiCall,
  settleAiCall,
  startAiRunStep,
} from '../system/browser';
import { createTrackedAiClient } from '../tracked-ai-client';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  hasTenantPredicate,
  newAiRunTestDatabase,
  recordStatements,
  rowsOf,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (db: DatabaseInterface, tenantId: string | null) => ({
  db,
  usageTracking: true,
  tenantId,
});

/** A failed durable workflow run of `tenantId` with one accepted step. */
async function failedWorkflow(
  db: DatabaseInterface,
  tenantId: string | null,
): Promise<string> {
  const run = await openAiRun(store(db, tenantId), {
    type: 'workflow',
    durable: true,
    definitionKey: 'brief',
    definitionVersion: '1',
    ownerId: 'owner-1',
    checkpoint: { state: { accepted: [] } },
  });
  await startAiRunStep(db, run.id, {
    stepIndex: 0,
    checkpoint: {
      expectedRevision: 0,
      state: { accepted: ['step-zero-output'] },
    },
  });
  await finishAiRun(db, run.id, {
    status: 'failed',
    stopReason: 'repairs_exhausted',
  });
  return run.id;
}

async function runCount(db: DatabaseInterface): Promise<number> {
  return rowsOf(await db.query('SELECT id FROM _smrt_ai_runs')).length;
}

describe.each(
  aiRunTestEngines,
)('run references stay in their tenant on %s', (engine) => {
  it('refuses a retry of another tenant run exactly as an unknown id, and opens nothing', async () => {
    const db = await newAiRunTestDatabase(engine);
    const sourceId = await failedWorkflow(db, 'tenant-two');
    const before = await runCount(db);

    const refusal = await openAiRun(store(db, 'tenant-one'), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      ownerId: 'owner-1',
      retryOfRunId: sourceId,
      retry: { acceptsVersion: () => true },
    }).catch((error) => error);
    const unknownId = crypto.randomUUID();
    const unknown = await openAiRun(store(db, 'tenant-one'), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      retryOfRunId: unknownId,
    }).catch((error) => error);

    expect(refusal).toBeInstanceOf(AiRunResumeRefusedError);
    expect(unknown).toBeInstanceOf(AiRunResumeRefusedError);
    expect(refusal.reason).toBe('retry_source_pruned');
    expect(refusal.reason).toBe(unknown.reason);
    expect(refusal.message.replace(sourceId, '<id>')).toBe(
      unknown.message.replace(unknownId, '<id>'),
    );
    expect(await runCount(db)).toBe(before);
  });

  it('does not name the other definition when a retry asks for the wrong one', async () => {
    const db = await newAiRunTestDatabase(engine);
    const sourceId = await failedWorkflow(db, 'tenant-one');
    const refusal = await openAiRun(store(db, 'tenant-one'), {
      type: 'workflow',
      definitionKey: 'another-definition',
      definitionVersion: '1',
      retryOfRunId: sourceId,
    }).catch((error) => error);
    expect(refusal).toMatchObject({ reason: 'not_retryable' });
    expect(refusal.message).not.toContain('brief');
  });

  it('refuses a global retry source for a tenant run, and a tenant source for a global run', async () => {
    const db = await newAiRunTestDatabase(engine);
    const globalSource = await failedWorkflow(db, null);
    const tenantSource = await failedWorkflow(db, 'tenant-one');
    await expect(
      openAiRun(store(db, 'tenant-one'), {
        type: 'workflow',
        definitionKey: 'brief',
        definitionVersion: '1',
        retryOfRunId: globalSource,
      }),
    ).rejects.toMatchObject({ reason: 'retry_source_pruned' });
    await expect(
      openAiRun(store(db, null), {
        type: 'workflow',
        definitionKey: 'brief',
        definitionVersion: '1',
        retryOfRunId: tenantSource,
      }),
    ).rejects.toMatchObject({ reason: 'retry_source_pruned' });
  });

  it('retries a run of the same tenant and carries its checkpoint (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const sourceId = await failedWorkflow(db, 'tenant-one');
    const retry = await openAiRun(store(db, 'tenant-one'), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      retryOfRunId: sourceId,
    });
    expect(retry).toMatchObject({
      tenantId: 'tenant-one',
      retryOfRunId: sourceId,
    });
    expect((await readAiRunCheckpoint(db, retry.id))?.state).toEqual({
      accepted: ['step-zero-output'],
    });
    // The global scope retries its own runs too.
    const globalSource = await failedWorkflow(db, null);
    const globalRetry = await openAiRun(store(db, null), {
      type: 'workflow',
      definitionKey: 'brief',
      definitionVersion: '1',
      retryOfRunId: globalSource,
    });
    expect(globalRetry.tenantId).toBeNull();
  });

  it('refuses a parent of another tenant as not found and leaves its trajectory alone', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db, 'tenant-two'), { type: 'turn' });
    const before = await runCount(db);
    const refusal = await openAiRun(store(db, 'tenant-one'), {
      type: 'turn',
      parentRunId: parent.id,
      handoff: { name: 'child' },
    }).catch((error) => error);
    expect(refusal).toBeInstanceOf(AiRunNotFoundError);
    expect(await runCount(db)).toBe(before);
    const trajectory = await getRunTrajectory(db, parent.id);
    expect(trajectory?.entries ?? []).toEqual([]);

    // A parent that is not running is refused as not found as well: its
    // status is not revealed to another tenant.
    await finishAiRun(db, parent.id, { status: 'done' });
    await expect(
      openAiRun(store(db, 'tenant-one'), {
        type: 'turn',
        parentRunId: parent.id,
      }),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
  });

  it('opens a child under a parent of the same tenant (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db, 'tenant-one'), {
      type: 'turn',
    });
    const child = await openAiRun(store(db, 'tenant-one'), {
      type: 'turn',
      parentRunId: parent.id,
      handoff: { name: 'child' },
    });
    expect(child).toMatchObject({
      tenantId: 'tenant-one',
      parentRunId: parent.id,
    });
    const trajectory = await getRunTrajectory(db, parent.id);
    expect(
      trajectory?.entries.some((entry) => entry.event?.childRunId === child.id),
    ).toBe(true);
  });

  it('applies the same rule through the tracked client', async () => {
    const db = await newAiRunTestDatabase(engine);
    const ai = { type: 'openai', model: 'gpt-4o' } as const;
    const one = createTrackedAiClient({ db, tenantId: 'tenant-one', ai });
    const two = createTrackedAiClient({ db, tenantId: 'tenant-two', ai });
    const { run: parent } = await two.openRun({ type: 'turn' });
    await expect(
      one.openRun({ type: 'turn', parentRunId: parent.id }),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
    const { run: own } = await two.openRun({
      type: 'turn',
      parentRunId: parent.id,
    });
    expect((await getAiRun(db, own.id))?.parentRunId).toBe(parent.id);
  });

  it('reads nothing of a refused reference but its tenant, and locks nothing of it', async () => {
    const db = await newAiRunTestDatabase(engine);
    const foreign = await openAiRun(store(db, 'tenant-two'), { type: 'turn' });
    // Every statement, on the handle and inside its transactions.
    const seen: string[] = [];
    const record = (handle: DatabaseInterface) =>
      new Proxy(handle, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== 'query' || typeof value !== 'function') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (sql: string, ...params: unknown[]) => {
            if (params.includes(foreign.id)) {
              seen.push(sql.replace(/\s+/g, ' '));
            }
            return value.call(target, sql, ...params);
          };
        },
      });
    const originalTransaction = db.transaction?.bind(db);
    (db as { transaction: unknown }).transaction = (
      operation: (tx: DatabaseInterface) => Promise<unknown>,
      ...rest: unknown[]
    ) =>
      (originalTransaction as (...args: unknown[]) => Promise<unknown>)(
        (tx: DatabaseInterface) => operation(record(tx)),
        ...rest,
      );
    const original = db.query.bind(db);
    (db as { query: unknown }).query = record({
      query: original,
    } as unknown as DatabaseInterface).query;
    await expect(
      openAiRun(store(db, 'tenant-one'), {
        type: 'turn',
        parentRunId: foreign.id,
      }),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
    (db as { query: unknown }).query = original;
    (db as { transaction: unknown }).transaction = originalTransaction;
    expect(seen).toEqual(['SELECT tenant_id FROM _smrt_ai_runs WHERE id = $1']);
  });

  it('stops charges and cancellation at an existing link to another tenant', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db, 'tenant-two'), { type: 'turn' });
    const child = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    // A link written before parents were tenant-checked.
    await db.query(
      'UPDATE _smrt_ai_runs SET parent_run_id = $1 WHERE id = $2',
      parent.id,
      child.id,
    );
    const callId = crypto.randomUUID();
    await reserveAiCall(db, child.id, { callId, inputTokens: 10 });
    await settleAiCall(db, {
      runId: child.id,
      callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    expect(await getAiRun(db, child.id)).toMatchObject({
      calls: 1,
      tokens: 12,
    });
    expect(await getAiRun(db, parent.id)).toMatchObject({
      inclusiveCalls: 0,
      inclusiveTokens: 0,
      reservedCalls: 0,
    });
    // Cancelling the foreign parent leaves the child running.
    await cancelAiRun(db, parent.id);
    expect((await getAiRun(db, child.id))?.status).toBe('running');
  });

  it('never reads a run of another tenant across an existing link, up or down', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db, 'tenant-two'), { type: 'turn' });
    const child = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    const grandchild = await openAiRun(store(db, 'tenant-two'), {
      type: 'turn',
    });
    // Links written before parents were tenant-checked.
    await db.query(
      'UPDATE _smrt_ai_runs SET parent_run_id = $1 WHERE id = $2',
      parent.id,
      child.id,
    );
    await db.query(
      'UPDATE _smrt_ai_runs SET parent_run_id = $1 WHERE id = $2',
      child.id,
      grandchild.id,
    );
    const unscoped: string[] = [];
    const restore = recordStatements(db, (sql, params) => {
      if (
        (params.includes(parent.id) || params.includes(grandchild.id)) &&
        !hasTenantPredicate(sql)
      ) {
        unscoped.push(sql);
      }
    });
    const callId = crypto.randomUUID();
    await reserveAiCall(db, child.id, { callId, inputTokens: 10 });
    await settleAiCall(db, {
      runId: child.id,
      callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    // The descendant walk asks for children in the child's tenant only.
    const restoreChildren = recordStatements(db, (sql) => {
      if (/WHERE parent_run_id = \$1/.test(sql) && !hasTenantPredicate(sql)) {
        unscoped.push(sql);
      }
    });
    await cancelAiRun(db, child.id);
    restoreChildren();
    restore();
    expect(unscoped).toEqual([]);
    expect((await getAiRun(db, grandchild.id))?.status).toBe('running');
  });
});
