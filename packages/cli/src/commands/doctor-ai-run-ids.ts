/**
 * `smrt doctor --db`: the AI run id registry (schema 1.20.0;
 * docs/content/ai-runs.md section 8, "Run identity").
 *
 * A run id names at most one run for the lifetime of the database. The
 * check counts referenced run ids that have neither a run row nor a
 * registry row (an older core pruned or wrote them without reserving them,
 * so they could be opened again) and runs created before their own parent
 * (a parent id reused before the registry existed). Diagnostic only: it
 * writes nothing.
 */

import {
  type AiRunIdRegistryCheck,
  checkAiRunIdRegistry,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  closeDatabaseConnection,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** One doctor run of the registry check. */
export interface AiRunIdRegistryOutcome {
  check: AiRunIdRegistryCheck | null;
  /** Human-readable failure reason; non-null exactly when `check` is null. */
  error: string | null;
}

async function connect(): Promise<{ db: DatabaseInterface; dbType: string }> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');
  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  if (!config.database?.url || config.database.url === ':memory:') {
    throw new Error(
      'No persistent database is configured. Set `database.url` in smrt.config.ts (or DATABASE_URL).',
    );
  }
  const dbType = config.database.type || 'sqlite';
  const { getDatabase } = await import('@happyvertical/sql');
  const db = await getDatabase({ type: dbType, url: config.database.url });
  return { db, dbType };
}

/**
 * Run the check on `options.db`, or on the configured database (opened and
 * closed here). Never throws for an operational problem.
 */
export async function runAiRunIdRegistryCheck(
  options: { db?: DatabaseInterface; typeHint?: string } = {},
): Promise<AiRunIdRegistryOutcome> {
  let owned: DatabaseInterface | undefined;
  try {
    let db = options.db;
    let typeHint = options.typeHint;
    if (!db) {
      const connection = await connect();
      owned = connection.db;
      db = connection.db;
      typeHint = connection.dbType;
    }
    return { check: await checkAiRunIdRegistry(db, typeHint), error: null };
  } catch (error) {
    return {
      check: null,
      error: redactDatabaseUrlsInText(
        error instanceof Error ? error.message : String(error),
      ),
    };
  } finally {
    await closeDatabaseConnection(owned);
  }
}

/** The lines `smrt doctor --db` prints for the check. */
export function formatAiRunIdRegistryCheck(
  check: AiRunIdRegistryCheck,
): string[] {
  return [
    `   Referenced run ids with no run row and no registry row: ${check.unregisteredIds}`,
    `   Runs created before their own parent: ${check.childrenOlderThanParent}`,
    ...(check.unregisteredIds > 0 || check.childrenOlderThanParent > 0
      ? [
          '   An older core opened or pruned runs without the run id registry, or a run id',
          '   was reused before the 1.20.0 upgrade. Drain older-core openers and sweepers;',
          '   see docs/content/ai-runs.md section 8, "Run identity".',
        ]
      : []),
  ];
}
