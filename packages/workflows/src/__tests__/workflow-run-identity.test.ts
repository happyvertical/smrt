/**
 * Workflow runs under core's run identity (docs/content/ai-runs.md sections
 * 7 and 8): a retry never reuses an id that named a run, never carries
 * another owner's checkpoint, and a checkpoint load reads only rows of its
 * own tenant, owner and run type. Real SQLite and DuckDB; scripted model.
 */
import {
  AiRunIdUsedError,
  AiRunResumeRefusedError,
  finishAiRun,
  getAiRun,
  openAiRun,
  pruneAiRuns,
  pruneAiRunTrajectories,
  readAiRunCheckpoint,
} from '@happyvertical/smrt-core';
import { clearPromptCache, PromptRegistry } from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRunCheckpointStore,
  WorkflowRunNotFoundError,
  type WorkflowStep,
} from '../index.js';
import {
  closeWorkflowDbs,
  definePrompts,
  definitionOf,
  driverFor,
  type Engine,
  scriptedModel,
  twoSteps,
  workflowDb,
} from './harness.js';

/** Every `getAiRun` call with its read scope, the driver's included. */
const { readScopes } = vi.hoisted(() => ({
  readScopes: [] as { runId: unknown; scope: unknown }[],
}));
vi.mock('@happyvertical/smrt-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-core')>();
  return {
    ...actual,
    getAiRun: (db: unknown, runId: unknown, scope?: unknown) => {
      readScopes.push({ runId, scope });
      return (actual.getAiRun as (...args: unknown[]) => unknown)(
        db,
        runId,
        scope,
      );
    },
  };
});

const engines: Engine[] = ['sqlite', 'duckdb'];

beforeEach(() => {
  clearPromptCache();
  definePrompts();
});
afterEach(async () => {
  PromptRegistry.clear();
  await closeWorkflowDbs();
});

const failingSteps: WorkflowStep[] = [
  twoSteps[0] as WorkflowStep,
  { ...(twoSteps[1] as WorkflowStep), check: () => ({ failure: 'No.' }) },
];

async function pruneNow(db: DatabaseInterface, runId: string) {
  const status = (await getAiRun(db, runId))?.status;
  if (status === 'running') await finishAiRun(db, runId, { status: 'done' });
  await db.query(
    "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
    runId,
  );
  // Two hours on: past the hour a call's charge can still change (#5516).
  const now = new Date(Date.now() + 2 * 60 * 60_000);
  await pruneAiRunTrajectories(db, { maxAgeMs: 0, now });
  await pruneAiRuns(db, { maxAgeMs: 0, now });
}

function statementsOf(db: DatabaseInterface) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const original = db.query.bind(db);
  (db as { query: unknown }).query = (sql: string, ...params: unknown[]) => {
    seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return original(sql, ...params);
  };
  return {
    seen,
    restore: () => {
      (db as { query: unknown }).query = original;
    },
  };
}

describe.each(engines)('workflow run identity on %s', (engine) => {
  it('refuses a retry with a caller id that named a pruned run, and leaves the failed run untouched', async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const driver = driverFor(db, model, definitionOf(failingSteps));
    const old = await driver.start({ ownerId: 'owner', input: { n: 0 } });
    await pruneNow(db, old.id);
    const failed = await driver.start({ ownerId: 'owner', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner')).status).toBe('failed');
    const before = await readAiRunCheckpoint(db, failed.id);
    await expect(
      driver.retry(failed.id, 'owner', { id: old.id }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    expect(await getAiRun(db, old.id)).toBeNull();
    expect((await getAiRun(db, failed.id))?.status).toBe('failed');
    expect(await readAiRunCheckpoint(db, failed.id)).toEqual(before);
  });

  it("never carries another owner's checkpoint, same definition", async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const driver = driverFor(db, model, definitionOf(failingSteps));
    const failed = await driver.start({ ownerId: 'owner-q', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner-q')).status).toBe('failed');
    const before = await db.query('SELECT id FROM _smrt_ai_runs');
    const checkpoint = await readAiRunCheckpoint(db, failed.id);
    // The workflow reads only the caller's own runs; core refuses the other
    // owner's source under its lock and the refusal is reported as not
    // found. Nothing is opened or carried.
    readScopes.length = 0;
    await expect(driver.retry(failed.id, 'owner-p')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
    const sourceReads = readScopes.filter(({ runId }) => runId === failed.id);
    expect(sourceReads.length).toBeGreaterThan(0);
    for (const { scope } of sourceReads) {
      expect(scope).toMatchObject({ ownerId: 'owner-p', type: 'workflow' });
    }
    expect(await db.query('SELECT id FROM _smrt_ai_runs')).toEqual(before);
    expect(await readAiRunCheckpoint(db, failed.id)).toEqual(checkpoint);
  });

  it("reports another owner's run as not found without reading its row when its checkpoint is gone", async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const driver = driverFor(db, model, definitionOf(failingSteps));
    const failed = await driver.start({ ownerId: 'owner-q', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner-q')).status).toBe('failed');
    // The checkpoint is pruned, so the owner-scoped checkpoint load misses
    // for the run's own owner too: the fallback read is what is judged.
    await db.query(
      'DELETE FROM _smrt_ai_run_checkpoints WHERE run_id = $1',
      failed.id,
    );
    readScopes.length = 0;
    await expect(driver.retry(failed.id, 'owner-p')).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError,
    );
    const sourceReads = readScopes.filter(({ runId }) => runId === failed.id);
    expect(sourceReads.length).toBeGreaterThan(0);
    for (const { scope } of sourceReads) {
      expect(scope).toMatchObject({ ownerId: 'owner-p', type: 'workflow' });
    }
    // The run's own owner is told the source is pruned (control).
    await expect(driver.retry(failed.id, 'owner-q')).rejects.toMatchObject({
      reason: 'retry_source_pruned',
    });
  });

  it.each([
    'start',
    'retry',
  ])('refuses an empty caller id on %s before anything is written', async (entry) => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const driver = driverFor(db, model, definitionOf(failingSteps));
    const failed = await driver.start({ ownerId: 'owner', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner')).status).toBe('failed');
    const before = await db.query('SELECT id FROM _smrt_ai_runs');
    for (const id of ['', 42 as unknown as string]) {
      const attempt =
        entry === 'start'
          ? driver.start({ ownerId: 'owner', id, input: { n: 2 } })
          : driver.retry(failed.id, 'owner', { id });
      await expect(attempt).rejects.toBeInstanceOf(TypeError);
    }
    expect(await db.query('SELECT id FROM _smrt_ai_runs')).toEqual(before);
  });

  it.each([
    'start',
    'retry',
  ])('reads a caller id once on %s: an id that is empty on the first read is refused', async (entry) => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const driver = driverFor(db, model, definitionOf(failingSteps));
    const failed = await driver.start({ ownerId: 'owner', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner')).status).toBe('failed');
    const before = await db.query('SELECT id FROM _smrt_ai_runs');
    let reads = 0;
    // Empty on the first read, absent on any later one.
    const shifting = {
      ownerId: 'owner',
      input: { n: 2 },
      get id() {
        reads += 1;
        return reads === 1 ? '' : undefined;
      },
    } as { ownerId: string; input: { n: number }; id?: string };
    const attempt =
      entry === 'start'
        ? driver.start(shifting)
        : driver.retry(failed.id, 'owner', shifting);
    await expect(attempt).rejects.toBeInstanceOf(TypeError);
    expect(reads).toBe(1);
    expect(await db.query('SELECT id FROM _smrt_ai_runs')).toEqual(before);
  });

  it('a pruned failed run is retry_source_pruned', async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const driver = driverFor(db, model, definitionOf(failingSteps));
    const failed = await driver.start({ ownerId: 'owner', input: { n: 1 } });
    expect((await driver.run(failed.id, 'owner')).status).toBe('failed');
    await pruneNow(db, failed.id);
    await expect(driver.retry(failed.id, 'owner')).rejects.toMatchObject({
      reason: 'retry_source_pruned',
    });
  });

  it("a checkpoint load issues no statement that can return another run's row", async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const run = await driverFor(db, model).start({ ownerId: 'owner' });
    const store = createRunCheckpointStore({ db, ownerId: 'owner' });
    const recorder = statementsOf(db);
    expect((await store.load(run.id))?.run.id).toBe(run.id);
    recorder.restore();
    const reads = recorder.seen.filter(
      ({ sql, params }) =>
        params.includes(run.id) &&
        /FROM _smrt_ai_run(s|_checkpoints)\b/.test(sql),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const { sql } of reads) {
      expect(sql).toMatch(/tenant_id (=|IS NULL)/);
      expect(sql).toMatch(/owner_id = \$/);
      expect(sql).toMatch(/type = \$/);
    }
  });

  it('a checkpoint load returns nothing for a run of another owner, and reads none of its rows', async () => {
    const db = await workflowDb(engine);
    const { model } = scriptedModel((_call, n) => ({ output: { value: n } }));
    const run = await driverFor(db, model).start({ ownerId: 'owner' });
    const stranger = createRunCheckpointStore({ db, ownerId: 'stranger' });
    expect(await stranger.load(run.id)).toBeNull();
    // An ordinary run of the same id in the same tenant opened by core is
    // impossible now; a direct open of the id is refused.
    await expect(
      openAiRun({ db, usageTracking: true }, { id: run.id, type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
  });
});
