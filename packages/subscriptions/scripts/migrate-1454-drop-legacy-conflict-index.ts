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

async function main(): Promise<void> {
  const databaseUrl = process.argv[2];
  if (!databaseUrl) {
    process.stderr.write(
      'Usage: migrate-1454-drop-legacy-conflict-index.ts <database-url>\n',
    );
    process.exit(1);
  }

  const config = databaseUrl.startsWith('postgres')
    ? { type: 'postgres' as const, url: databaseUrl }
    : { type: 'sqlite' as const, url: databaseUrl };

  const db = await getDatabase(config);

  try {
    process.stdout.write(
      `Dropping legacy index ${LEGACY_INDEX_NAME} (if present)...\n`,
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
