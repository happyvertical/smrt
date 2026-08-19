/**
 * Issue #2364 (epic #2382, finding A3) — the agent-schedule poll predicate
 * indexed on the PRODUCTION manifest schema path.
 *
 * `createIsolatedTestDbFromManifest()` with no explicit path auto-detects
 * this package's own freshly-generated manifest and renders tables + indexes
 * through the same structured-schema renderer `smrt db:migrate` uses (#2358)
 * — so this proves the declared composite is actually emitted for the real
 * shipped `AgentSchedule` class, not just the schema generator's synthetic
 * fixtures in `@happyvertical/smrt-core`'s `schema-path-parity.test.ts`.
 */

import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Row = Record<string, unknown>;

async function rows(db: DatabaseInterface, sql: string): Promise<Row[]> {
  const result = await db.query(sql);
  return Array.isArray(result)
    ? (result as Row[])
    : ((result as { rows?: Row[] }).rows ?? []);
}

describe('agent-schedule poll predicate index reaches the production manifest schema path (#2364)', () => {
  let baseDb: DatabaseInterface;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ baseDb, cleanup } = await createIsolatedTestDbFromManifest({
      includeObjects: ['AgentSchedule'],
    }));
  });

  afterEach(async () => {
    await cleanup();
  });

  it('indexes `ScheduleRunner.poll()`s `(enabled, status, next_run)` predicate on `_smrt_agent_schedules`', async () => {
    const result = await rows(
      baseDb,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '_smrt_agent_schedules'`,
    );
    const names = result.map((row) => String(row.name));
    expect(names).toContain(
      '_smrt_agent_schedules_enabled_status_next_run_idx',
    );
  });
});
