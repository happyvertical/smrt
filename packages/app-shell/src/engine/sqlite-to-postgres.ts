// Moving an existing SQLite user app into its PostgreSQL schema (#5193).
//
// The cloud profile refuses to open an app that still lives in an `app.db`
// beside an empty PostgreSQL schema (its rows would seem to vanish). This is
// the explicit migration that clears that refusal:
//
// 1. export the SQLite app (one read transaction). The engine records its own
//    bookkeeping rows (`_smrt_changes`, `_smrt_migrations`) the first time it
//    opens a file; that is the only write, user rows are never touched, and the
//    export is stable from then on (a byte copy per run would re-stamp them and
//    make a rerun look like different data). The file is never removed,
// 2. install the bundle into the host's schema with `importUserApp` (one
//    transaction, verified before commit; a match is `already-imported`,
//    other data is refused, so a rerun is safe),
// 3. verify the schema against the bundle again, then
// 4. record a marker file beside `app.db` (atomic rename, after the commit): a
//    hint for operators. What lets the app open on PostgreSQL is the completion
//    fact the import writes into the schema's own `_app_meta` in its
//    transaction (`MIGRATION_COMPLETION_KEY`). `app.db` stays, a snapshot as of
//    the migration, until an operator removes it.
//
// The schema comes only from the host's `database` config, never from input.
// Waiting changes, drafts and who may run this are the CALLER's (see
// `lib/server`); this module only moves the data.
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { assertDatabaseConfig, type DatabaseConfig } from './db/index.ts';
import { EngineError } from './errors.ts';
import {
  exportUserApp,
  hasUserAppDatabase,
  importUserApp,
  readAppMetaValue,
  verifyUserApp,
} from './portable-export.ts';
import type { VersionRecord } from './store.ts';

/** The marker file, in the app's live directory. */
export const POSTGRES_MIGRATION_MARKER = 'postgres-migration.json';

/** What the marker records: the schema it moved to and what moved. */
export interface PostgresMigrationMarker {
  format: 1;
  schema: string;
  /** The bundle digest the schema was verified against. */
  digest: string;
  version: number;
  tables: number;
  rows: number;
  migratedAt: string;
}

export interface MigrateToPostgresOptions {
  /** The app's live directory, holding `app.db`. */
  dataDir: string;
  /** The host's config for this app's schema (PostgreSQL or PGlite). */
  database: DatabaseConfig;
  /** The app's version history from the caller's own store, oldest first. */
  versions: VersionRecord[];
  /** Creates the schema if needed; the engine never does. */
  provision?: () => Promise<void>;
  /** Test seam: observe phases (`exported`, `imported`, `verified`). */
  onPhase?: (phase: string) => void | Promise<void>;
  /** Test seam: runs inside the PostgreSQL transaction; throwing rolls it back. */
  onTransaction?: () => void | Promise<void>;
}

export interface MigrateToPostgresResult {
  /** `already-migrated`: the schema already held this very data and the marker was in place. */
  status: 'migrated' | 'already-migrated';
  tables: number;
  rows: number;
  digest: string;
}

/** The marker of this directory, or null when absent or malformed. */
export function readPostgresMigrationMarker(
  dataDir: string,
): PostgresMigrationMarker | null {
  try {
    const m = JSON.parse(
      readFileSync(join(dataDir, POSTGRES_MIGRATION_MARKER), 'utf8'),
    ) as Partial<PostgresMigrationMarker>;
    if (
      m.format === 1 &&
      typeof m.schema === 'string' &&
      typeof m.digest === 'string' &&
      Number.isSafeInteger(m.version) &&
      Number.isSafeInteger(m.tables) &&
      Number.isSafeInteger(m.rows) &&
      typeof m.migratedAt === 'string'
    )
      return m as PostgresMigrationMarker;
  } catch {
    // absent or unreadable: not migrated
  }
  return null;
}

/** The key of the completion fact in the app's `_app_meta`. */
export const MIGRATION_COMPLETION_KEY = 'sqlite-migration';

/**
 * True when the SQLite file was moved into `database`'s schema: the schema's own
 * `_app_meta` holds the completion fact, written once inside the import's
 * transaction. It is immutable, so a later undo, a removed model or a cleanup
 * never changes the answer; a dropped, recreated or emptied schema has no such
 * row, so the host never opens a fresh empty schema over an app. The marker
 * file is only a hint and decides nothing.
 */
export async function isMigratedToPostgres(
  dataDir: string,
  database: DatabaseConfig,
): Promise<boolean> {
  if (database.kind === 'sqlite') return false;
  const value = await readAppMetaValue({
    dataDir,
    database,
    key: MIGRATION_COMPLETION_KEY,
  });
  return value !== null;
}

function writeMarker(dataDir: string, marker: PostgresMigrationMarker): void {
  const file = join(dataDir, POSTGRES_MIGRATION_MARKER);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Move the SQLite user app in `dataDir` into `database`'s schema. Rerunnable
 * after a crash: the rows and the completion fact commit together, so a crash
 * leaves no fact and no marker file, and a plain rerun converges. Once the fact
 * exists nothing is compared or moved again. It never puts old data back: a
 * marker file with no fact in the schema (dropped, recreated or emptied), a
 * schema that already matches without the fact, or other data are refused.
 * `app.db` is never removed or given a user-row change.
 */
export async function migrateUserAppToPostgres(
  options: MigrateToPostgresOptions,
): Promise<MigrateToPostgresResult> {
  const { dataDir, database } = options;
  if (database.kind === 'sqlite')
    throw new EngineError('the target is not a PostgreSQL database', 'refused');
  assertDatabaseConfig(database);
  if (!hasUserAppDatabase(dataDir))
    throw new EngineError('there is no SQLite user app to migrate', 'refused');
  const marked = readPostgresMigrationMarker(dataDir);
  if (marked && marked.schema !== database.schema)
    throw new EngineError(
      'this app was already migrated into a different schema; nothing was changed',
      'refused',
    );

  const recorded = await readAppMetaValue({
    dataDir,
    database,
    key: MIGRATION_COMPLETION_KEY,
  });
  if (recorded !== null) {
    // Done: the schema is the app now (the host may have written to it since).
    const fact = parseCompletion(recorded);
    // The kept SQLite file is a snapshot, so it still digests to what moved; a
    // different app pointed at a completed schema is refused.
    const source = await exportUserApp({ dataDir, versions: options.versions });
    if (source.digest !== fact.digest)
      throw new EngineError(
        'the schema holds a different app than this SQLite file; nothing was changed',
        'refused',
      );
    if (!marked || marked.digest !== fact.digest) writeMarker(dataDir, fact);
    return {
      status: 'already-migrated',
      tables: fact.tables,
      rows: fact.rows,
      digest: fact.digest,
    };
  }
  if (marked)
    throw new EngineError(
      'a migration marker exists but the schema holds no completion record (dropped, recreated or emptied); nothing was imported. An operator must remove the marker after checking the schema',
      'refused',
    );

  const bundle = await exportUserApp({ dataDir, versions: options.versions });
  await options.onPhase?.('exported');
  await options.provision?.();
  const rows = bundle.tables.reduce((n, t) => n + t.rows.length, 0);
  const fact: PostgresMigrationMarker = {
    format: 1,
    schema: database.schema,
    digest: bundle.digest,
    version: bundle.version,
    tables: bundle.tables.length,
    rows,
    migratedAt: new Date().toISOString(),
  };
  const imported = await importUserApp({
    dataDir,
    database,
    bundle,
    completion: {
      key: MIGRATION_COMPLETION_KEY,
      value: JSON.stringify(fact),
    },
    onTransaction: options.onTransaction,
  });
  if (imported.status !== 'imported')
    throw new EngineError(
      'the schema already holds this app without a completion record; it was not written by this migration, so nothing was marked',
      'refused',
    );
  await options.onPhase?.('imported');
  const verified = await verifyUserApp({ dataDir, database, bundle });
  if (!verified.ok)
    throw new EngineError(
      'the PostgreSQL copy did not match the SQLite app; the app stays closed',
      'refused',
    );
  await options.onPhase?.('verified');
  // After the commit only: a hint, never the decision.
  writeMarker(dataDir, fact);
  return {
    status: 'migrated',
    tables: fact.tables,
    rows: fact.rows,
    digest: fact.digest,
  };
}

function parseCompletion(text: string): PostgresMigrationMarker {
  try {
    const m = JSON.parse(text) as Partial<PostgresMigrationMarker>;
    if (m.format === 1 && typeof m.schema === 'string')
      return m as PostgresMigrationMarker;
  } catch {
    // fall through
  }
  throw new EngineError('the completion record is unreadable', 'refused');
}
