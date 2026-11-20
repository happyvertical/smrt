/**
 * Opening a run validates and writes one snapshot of its store and input
 * (docs/content/ai-runs.md section 3): the tenant, parent and handoff
 * checked are the ones written, even if the caller changes its objects while
 * the open runs. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { openAiRun } from '../system/browser';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  readsRunRow,
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

async function eventCount(db: DatabaseInterface, runId: string) {
  return rowsOf(
    await db.query(
      'SELECT id FROM _smrt_ai_run_events WHERE run_id = $1',
      runId,
    ),
  ).length;
}

describe.each(aiRunTestEngines)('open snapshot on %s', (engine) => {
  it('writes the tenant, parent and handoff it validated when the caller changes its objects mid-open', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    const foreign = await openAiRun(store(db, 'tenant-two'), { type: 'turn' });
    const opening = store(db, 'tenant-one');
    const input = {
      type: 'turn',
      parentRunId: parent.id,
      handoff: { name: 'validated' },
    };
    const restore = beforeStatement(db, readsRunRow(parent.id), () => {
      // The shared objects change after validation, before the insert.
      opening.tenantId = 'tenant-two';
      input.parentRunId = foreign.id;
      input.handoff.name = 'changed';
    });
    const child = await openAiRun(opening, input);
    restore();
    expect(child).toMatchObject({
      tenantId: 'tenant-one',
      parentRunId: parent.id,
    });
    const handoffs = rowsOf(
      await db.query(
        "SELECT run_id, name FROM _smrt_ai_run_events WHERE type = 'handoff'",
      ),
    );
    expect(handoffs).toEqual([{ run_id: parent.id, name: 'validated' }]);
    expect(await eventCount(db, foreign.id)).toBe(0);
  });
});
