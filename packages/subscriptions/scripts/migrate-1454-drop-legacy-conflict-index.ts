#!/usr/bin/env node

/**
 * Migration script for smrt#1454: polymorphic subscriber conflict-key drift.
 *
 * Drops the legacy single-column unique index
 * `_smrt_tenant_subscriptions_tenant_id_idx` left behind on databases that
 * were created against the pre-polymorphic conflictColumns: ['tenant_id'].
 *
 * Why this exists: `smrt db:migrate` (without `--drop-indexes`) does not
 * sweep orphan indexes by design, so the new three-column unique index for
 * `(tenant_id, subscriber_kind, subscriber_external_id)` lands alongside the
 * old single-column one. The OLD index still enforces "one subscription per
 * tenant" and rejects external subscribers — defeating the whole point of
 * the polymorphic feature on upgraded databases.
 *
 * Fresh databases never see this script: their schema is generated from the
 * post-#1454 manifest directly.
 *
 * Usage:
 *   npx tsx node_modules/@happyvertical/smrt-subscriptions/scripts/migrate-1454-drop-legacy-conflict-index.ts <database-url>
 *
 * Examples:
 *   # SQLite
 *   npx tsx ...migrate-1454-drop-legacy-conflict-index.ts ./data/app.db
 *
 *   # Postgres
 *   npx tsx ...migrate-1454-drop-legacy-conflict-index.ts postgres://user:pass@host/db
 *
 * Idempotent: re-running is a no-op (`DROP INDEX IF EXISTS`).
 */

import { getDatabase } from '@happyvertical/sql';

const LEGACY_INDEX_NAME = '_smrt_tenant_subscriptions_tenant_id_idx';

/**
 * Detect the database engine from the URL / path. Supports the engines SMRT
 * itself supports — Postgres, DuckDB, SQLite — with SQLite as the last-resort
 * fallback. DuckDB is detected only so we can refuse it with a helpful error
 * (see {@link main}); this script cannot safely rewrite DuckDB schemas.
 */
function detectDatabaseType(input: string): 'postgres' | 'duckdb' | 'sqlite' {
  if (
    input.startsWith('postgres://') ||
    input.startsWith('postgresql://') ||
    input.startsWith('postgres:') ||
    input.startsWith('postgresql:')
  ) {
    return 'postgres';
  }
  if (input.startsWith('duckdb://') || /\.duckdb($|\?)/i.test(input)) {
    return 'duckdb';
  }
  return 'sqlite';
}

async function main(): Promise<void> {
  const databaseUrl = process.argv[2];
  if (!databaseUrl) {
    process.stderr.write(
      'Usage: migrate-1454-drop-legacy-conflict-index.ts <database-url>\n',
    );
    process.exit(1);
  }

  const type = detectDatabaseType(databaseUrl);

  // DuckDB stores UNIQUE constraints as inline `UNIQUE(...)` table
  // constraints rather than as named indexes, so `DROP INDEX IF EXISTS` is a
  // no-op against DuckDB and the legacy single-column uniqueness on
  // `tenant_id` would persist after this script "succeeds". Fixing it
  // safely needs a full table rebuild (CREATE new, copy, DROP old, RENAME)
  // that is too risky to bundle here as a one-shot script. Refuse loudly
  // with the manual procedure rather than pretending to migrate.
  if (type === 'duckdb') {
    process.stderr.write(
      'DuckDB databases cannot be migrated automatically with this script.\n' +
        'DuckDB stores the legacy `UNIQUE(tenant_id)` as an inline table constraint,\n' +
        'not as a named index, so DROP INDEX would silently do nothing. The safe\n' +
        'manual procedure is to rebuild the `_smrt_tenant_subscriptions` table:\n\n' +
        '  1. Create a temp copy with the new conflict constraint\n' +
        '     UNIQUE (tenant_id, subscriber_kind, subscriber_external_id)\n' +
        '  2. INSERT INTO temp SELECT ... FROM _smrt_tenant_subscriptions\n' +
        '  3. DROP TABLE _smrt_tenant_subscriptions\n' +
        '  4. ALTER TABLE temp RENAME TO _smrt_tenant_subscriptions\n\n' +
        'Run inside a transaction; back up first.\n',
    );
    process.exit(2);
  }

  const db = await getDatabase({ type, url: databaseUrl });

  try {
    process.stdout.write(
      `Connecting via ${type} adapter. Dropping legacy index ${LEGACY_INDEX_NAME} (if present)...\n`,
    );
    await db.query(`DROP INDEX IF EXISTS "${LEGACY_INDEX_NAME}"`);
    process.stdout.write('Done.\n');
  } finally {
    await db.close?.();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
