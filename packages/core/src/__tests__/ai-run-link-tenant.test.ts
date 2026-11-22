/**
 * `run_id` on a usage row is not a foreign key, so every read and delete that
 * follows it stays inside the run's tenant (docs/content/ai-runs.md section
 * 8, packages/core/agents/ai-usage.md "Retention" and "Readers"):
 *
 * - Run retention deletes only usage rows of the run's own tenant.
 * - A usage row leads its trajectory reader only to a run of its own tenant.
 *
 * Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiUsageRecorder } from '../adapters/ai-usage-recorder';
import {
  finishAiRun,
  getAiRun,
  getRunTrajectory,
  openAiRun,
  pruneAiRuns,
  pruneAiRunTrajectories,
  recordAiEvaluation,
  resumeAiRun,
  stopAiRun,
  sweepAiRuns,
  waitAiRunApproval,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

const DAY = 86_400_000;
const NOW = new Date('2026-11-14T12:00:00Z');

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const rawEvent = (tags: Record<string, string>) => ({
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'message',
  usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  duration: 1,
  tags,
});

describe.each(
  aiRunTestEngines,
)('run links stay in their tenant on %s', (engine) => {
  it('deletes only the run tenant usage rows when a run row is pruned', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    await finishAiRun(db, run.id, { status: 'done' });
    await db.query(
      'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
      new Date(NOW.getTime() - 200 * DAY).toISOString(),
      run.id,
    );
    const own = createAiUsageRecorder({ db, tenantId: 'tenant-one' });
    const other = createAiUsageRecorder({ db, tenantId: 'tenant-two' });
    await own(rawEvent({ runId: run.id, promptKey: 'tags.own' }));
    await other(rawEvent({ runId: run.id, promptKey: 'tags.other' }));

    await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW });
    expect(await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW })).toEqual({
      pruned: 1,
    });
    expect(await getAiRun(db, run.id)).toBeNull();
    const left = rowsOf(
      await db.query('SELECT prompt_key, tenant_id FROM _smrt_ai_usage'),
    );
    expect(left).toEqual([
      { prompt_key: 'tags.other', tenant_id: 'tenant-two' },
    ]);
  });

  it('reads a usage row naming another tenant run as a call on its own', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    const other = createAiUsageRecorder({ db, tenantId: 'tenant-two' });
    await other(rawEvent({ runId: run.id, promptKey: 'tags.other' }));
    const own = createAiUsageRecorder({ db, tenantId: 'tenant-one' });
    await own(rawEvent({ runId: run.id, promptKey: 'tags.own' }));
    const ids = Object.fromEntries(
      rowsOf(await db.query('SELECT id, prompt_key FROM _smrt_ai_usage')).map(
        (row) => [String(row.prompt_key), String(row.id)],
      ),
    );

    const foreign = await getRunTrajectory(
      db,
      {
        callId: ids['tags.other'] as string,
      },
      { allowCrossTenant: true },
    );
    expect(foreign?.run).toBeNull();
    expect(foreign?.entries).toHaveLength(1);
    expect(foreign?.entries[0]?.usage?.callId).toBe(ids['tags.other']);

    // The run's own tenant still reaches the run (control).
    const inRun = await getRunTrajectory(
      db,
      {
        callId: ids['tags.own'] as string,
      },
      { allowCrossTenant: true },
    );
    expect(inRun?.run?.id).toBe(run.id);
  });

  it('reads the run a usage row names in one statement scoped to the row tenant', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    const other = createAiUsageRecorder({ db, tenantId: 'tenant-two' });
    await other(rawEvent({ runId: run.id, promptKey: 'tags.other' }));
    const [row] = rowsOf(await db.query('SELECT id FROM _smrt_ai_usage'));
    const seen: string[] = [];
    const original = db.query.bind(db);
    (db as { query: unknown }).query = (sql: string, ...params: unknown[]) => {
      if (params.includes(run.id)) seen.push(sql.replace(/\s+/g, ' '));
      return original(sql, ...params);
    };
    expect(
      (
        await getRunTrajectory(
          db,
          { callId: String(row?.id) },
          { allowCrossTenant: true },
        )
      )?.run,
    ).toBeNull();
    (db as { query: unknown }).query = original;
    // One lookup, by id and tenant together: no check-then-read in which a
    // pruned and reused id could change hands, and nothing else of the run.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/WHERE r\.id = \$1 AND r\.tenant_id = \$2$/);

    // The row's own tenant reaches the run, and every statement reading the
    // run (its row, events and evaluations) is scoped to that tenant.
    await createAiUsageRecorder({ db, tenantId: 'tenant-one' })(
      rawEvent({ runId: run.id, promptKey: 'tags.own' }),
    );
    const own = rowsOf(
      await db.query(
        "SELECT id FROM _smrt_ai_usage WHERE tenant_id = 'tenant-one'",
      ),
    )[0];
    seen.length = 0;
    (db as { query: unknown }).query = (sql: string, ...params: unknown[]) => {
      if (params.includes(run.id)) seen.push(sql.replace(/\s+/g, ' '));
      return original(sql, ...params);
    };
    expect(
      (
        await getRunTrajectory(
          db,
          { callId: String(own?.id) },
          { tenantId: 'tenant-one' },
        )
      )?.run?.id,
    ).toBe(run.id);
    (db as { query: unknown }).query = original;
    expect(seen.length).toBeGreaterThan(1);
    for (const sql of seen) expect(sql).toMatch(/tenant_id (=|IS NULL)/);
  });

  it('returns a call on its own with its own tenant evaluations only', async () => {
    const db = await newAiRunTestDatabase(engine);
    const own = createAiUsageRecorder({ db, tenantId: 'tenant-one' });
    await own(rawEvent({ aiCallId: 'reused-call', promptKey: 'tags.one' }));
    await recordAiEvaluation(db, {
      callId: 'reused-call',
      label: 'tenant-one-label',
      evaluator: 'human',
    });
    // The row is pruned; another tenant's row later takes the same id.
    await db.query("DELETE FROM _smrt_ai_usage WHERE id = 'reused-call'");
    const other = createAiUsageRecorder({ db, tenantId: 'tenant-two' });
    await other(rawEvent({ aiCallId: 'reused-call', promptKey: 'tags.two' }));
    const trajectory = await getRunTrajectory(
      db,
      { callId: 'reused-call' },
      { allowCrossTenant: true },
    );
    expect(trajectory?.entries[0]?.usage?.promptKey).toBe('tags.two');
    expect(trajectory?.entries[0]?.evaluations).toEqual([]);
  });

  it('never lets a parent of another tenant decide a child sweep or retention', async () => {
    const db = await newAiRunTestDatabase(engine);
    const store = (tenantId: string) => ({ db, usageTracking: true, tenantId });
    const link = (parentId: string, childId: string) =>
      db.query(
        'UPDATE _smrt_ai_runs SET parent_run_id = $1 WHERE id = $2',
        parentId,
        childId,
      );
    // Two foreign parents, one still running and one done; each with a
    // waiting durable child of tenant-one (links written before the check).
    const running = await openAiRun(store('tenant-two'), { type: 'turn' });
    const done = await openAiRun(store('tenant-two'), { type: 'turn' });
    await finishAiRun(db, done.id, { status: 'done' });
    const waiting: string[] = [];
    for (const parent of [running, done]) {
      const child = await openAiRun(store('tenant-one'), {
        type: 'workflow',
        durable: true,
      });
      await waitAiRunApproval(db, child.id);
      await link(parent.id, child.id);
      waiting.push(child.id);
    }
    await sweepAiRuns(db, {});
    const statuses = await Promise.all(
      waiting.map(async (id) => (await getAiRun(db, id))?.status),
    );
    // The foreign parent's status decides nothing, and a parent row that
    // exists in another tenant is not a missing one: both children wait.
    expect(statuses).toEqual(['waiting-approval', 'waiting-approval']);

    // A durable stopped child under a foreign parent still resumes (its
    // ancestor is not missing).
    const stopped = await openAiRun(store('tenant-one'), {
      type: 'workflow',
      durable: true,
    });
    await stopAiRun(db, stopped.id);
    await link(done.id, stopped.id);
    await sweepAiRuns(db, {});
    expect((await getAiRun(db, stopped.id))?.status).toBe('stopped');
    expect((await resumeAiRun(db, stopped.id))?.status).toBe('running');

    // A child whose parent row is truly gone is still repaired (control).
    const orphan = await openAiRun(store('tenant-one'), {
      type: 'workflow',
      durable: true,
    });
    await waitAiRunApproval(db, orphan.id);
    await link(crypto.randomUUID(), orphan.id);
    await sweepAiRuns(db, {});
    expect((await getAiRun(db, orphan.id))?.status).toBe('cancelled');

    // A finished child under a running (protected) foreign parent follows
    // its own retention, not the parent's protection.
    const child = await openAiRun(store('tenant-one'), { type: 'turn' });
    await finishAiRun(db, child.id, { status: 'done' });
    await link(running.id, child.id);
    await db.query(
      'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
      new Date(NOW.getTime() - 200 * DAY).toISOString(),
      child.id,
    );
    await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW });
    expect((await getAiRun(db, child.id))?.trajectoryPruned).toBe(true);
    await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW });
    expect(await getAiRun(db, child.id)).toBeNull();
    expect((await getAiRun(db, running.id))?.status).toBe('running');
  });
});
