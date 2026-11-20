/**
 * An event append locks its run in the tenant its payload was redacted for
 * (docs/content/ai-runs.md section 8): a run id reused by another tenant
 * while the host redactor ran is never written to. Real SQLite and DuckDB
 * (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiRunNotFoundError,
  appendAiRunEvent,
  getRunTrajectory,
  openAiRun,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (db: DatabaseInterface, tenantId: string) => ({
  db,
  usageTracking: true,
  tenantId,
});

type Exec = (sql: string, ...params: unknown[]) => Promise<unknown>;

/** Another tenant now holds this run id. */
const reuse = (runId: string) => (exec: Exec) =>
  exec(
    "UPDATE _smrt_ai_runs SET tenant_id = 'tenant-two' WHERE id = $1",
    runId,
  );

async function eventCount(db: DatabaseInterface, runId: string) {
  return rowsOf(
    await db.query(
      'SELECT id FROM _smrt_ai_run_events WHERE run_id = $1',
      runId,
    ),
  ).length;
}

describe.each(aiRunTestEngines)('event append on %s', (engine) => {
  it('never appends a payload redacted for one tenant to a run another tenant now holds', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    await expect(
      appendAiRunEvent(
        db,
        run.id,
        { type: 'observation', payload: { note: 'for tenant-one' } },
        {
          redact: async (payload) => {
            // The run is pruned and reopened by another tenant meanwhile.
            await reuse(run.id)((sql, ...params) => db.query(sql, ...params));
            return payload;
          },
        },
      ),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
    expect(await eventCount(db, run.id)).toBe(0);
  });

  it('appends a redacted payload to a run that kept its tenant (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    await appendAiRunEvent(
      db,
      run.id,
      { type: 'observation', payload: { note: 'ok' } },
      { redact: async (payload) => payload },
    );
    expect((await getRunTrajectory(db, run.id))?.entries).toHaveLength(1);
  });
});
