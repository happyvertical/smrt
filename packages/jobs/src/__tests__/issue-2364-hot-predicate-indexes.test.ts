/**
 * Issue #2364 (epic #2382, finding A3) — hot predicate indexes reach the
 * PRODUCTION manifest schema path for the real shipped classes.
 *
 * `createIsolatedTestDbFromManifest()` with no explicit path auto-detects
 * this package's own freshly-generated manifest (`dist/manifest.json` /
 * `.smrt/manifest.json`) and renders tables + indexes through the same
 * structured-schema renderer `smrt db:migrate` uses (#2358) — so this proves
 * the declared indexes are actually emitted for `SmrtJob` and `ForgeDelivery`
 * as shipped, not just the schema generator's synthetic fixtures in
 * `@happyvertical/smrt-core`'s `schema-path-parity.test.ts`.
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

async function indexNames(
  db: DatabaseInterface,
  tableName: string,
): Promise<string[]> {
  const result = await rows(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${tableName}'`,
  );
  return result.map((row) => String(row.name));
}

describe('hot predicate indexes reach the production manifest schema path (#2364)', () => {
  let baseDb: DatabaseInterface;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ baseDb, cleanup } = await createIsolatedTestDbFromManifest({
      includeObjects: ['SmrtJob', 'ForgeDelivery'],
    }));
  });

  afterEach(async () => {
    await cleanup();
  });

  it('indexes the claim-loop predicate on `_smrt_jobs`: the (status, run_at) composite plus both single columns', async () => {
    const names = await indexNames(baseDb, '_smrt_jobs');
    // Composite for the WHERE clause `claimReady()`/`listReady()` poll ~1s.
    expect(names).toContain('_smrt_jobs_status_run_at_idx');
    // Single-column parts, per issue #2364's scope.
    expect(names).toContain('_smrt_jobs_status_idx');
    expect(names).toContain('_smrt_jobs_run_at_idx');
  });

  it('indexes both OR-branches of the forge-delivery claim predicate on `_smrt_forge_deliveries`', async () => {
    const names = await indexNames(baseDb, '_smrt_forge_deliveries');
    // `claimReady()`: (status IN ('pending','retry') AND next_attempt_at <= ?)
    expect(names).toContain(
      '_smrt_forge_deliveries_status_next_attempt_at_idx',
    );
    // `claimReady()`/the expired-lease sweep: (status = 'leased' AND lease_expires_at < ?)
    expect(names).toContain(
      '_smrt_forge_deliveries_status_lease_expires_at_idx',
    );
  });
});
