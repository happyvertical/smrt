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
// The way back, `downgradeUserAppToSqlite`, is allowed only while the hosted
// app has taken no writes since the move (see its comment).
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
import { EngineError, HostedWritesError } from './errors.ts';
import {
  countUserRows,
  dropAppSchemaChecked,
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
  /** The app's tenant (PostgreSQL rows carry it); default the engine's local tenant. */
  tenantId?: string;
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
  if (value === null) return false;
  // The row must be THIS schema's own fact (a copied schema would carry another's);
  // an unreadable one fails closed with its own message, not "not migrated".
  return parseCompletion(value).schema === database.schema;
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
    if (fact.schema !== database.schema)
      throw new EngineError(
        'the completion record in this schema names another schema (a copy?); nothing was changed',
        'refused',
      );
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
  // A schema with no completion row and no data (a crash after the tables were
  // built, before the commit) is completed by this import; one holding rows is not.
  const imported = await importUserApp({
    dataDir,
    database,
    bundle,
    completion: {
      key: MIGRATION_COMPLETION_KEY,
      value: JSON.stringify(fact),
    },
    onTransaction: options.onTransaction,
    tenantId: options.tenantId,
  });
  if (imported.status !== 'imported')
    throw new EngineError(
      'the schema already holds this app without a completion record; it was not written by this migration, so nothing was marked',
      'refused',
    );
  await options.onPhase?.('imported');
  const verified = await verifyUserApp({
    dataDir,
    database,
    bundle,
    tenantId: options.tenantId,
  });
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

export interface DowngradeToSqliteOptions {
  /** The app's live directory, holding the kept `app.db`. */
  dataDir: string;
  /** The host's config for this app's schema (PostgreSQL or PGlite). */
  database: DatabaseConfig;
  /** The app's version history from the caller's own store, oldest first. */
  versions: VersionRecord[];
}

export interface DowngradeToSqliteResult {
  status: 'downgraded';
  tables: number;
  rows: number;
  digest: string;
}

/**
 * Take a migrated app back to its kept `app.db` (#5193). Allowed only while the
 * hosted app has taken no writes since the migration; otherwise refused with
 * `HostedWritesError` and nothing changed.
 *
 * "Taken no writes" is read from the signal the migration already recorded: the
 * bundle digest in the completion fact (rows of every table plus the version
 * history). The schema's current export must digest to it, and so must the kept
 * file. Rows added, changed or removed, a new version (a publish or an undo) and
 * a changed history all move the digest, so nothing needs a write-time hook. The
 * check and the drop run under the app's claim, so no host can write between
 * them, and a host holding the app refuses the downgrade. Content-based by
 * design: a write that was fully reverted leaves nothing to lose and is allowed.
 *
 * It drops the schema (this removes the completion fact), then the marker file;
 * the app is then the SQLite file alone. A crash between the two is finished by
 * a rerun. The hosted shell refuses to open the app until it is migrated again.
 */
export async function downgradeUserAppToSqlite(
  options: DowngradeToSqliteOptions,
): Promise<DowngradeToSqliteResult> {
  const { dataDir, database } = options;
  if (database.kind === 'sqlite')
    throw new EngineError('the source is not a PostgreSQL database', 'refused');
  assertDatabaseConfig(database);
  if (!hasUserAppDatabase(dataDir))
    throw new EngineError(
      'the desktop app.db is not there, so there is nothing to go back to; nothing was changed',
      'refused',
    );
  const marked = readPostgresMigrationMarker(dataDir);
  const recorded = await readAppMetaValue({
    dataDir,
    database,
    key: MIGRATION_COMPLETION_KEY,
  });
  if (recorded === null && !marked)
    throw new EngineError(
      'this app was not migrated from a SQLite file to PostgreSQL; nothing was changed',
      'refused',
    );
  const fact = recorded !== null ? parseCompletion(recorded) : marked;
  if (!fact || fact.schema !== database.schema)
    throw new EngineError(
      'the migration record names another schema; nothing was changed',
      'refused',
    );
  const result: DowngradeToSqliteResult = {
    status: 'downgraded',
    tables: fact.tables,
    rows: fact.rows,
    digest: fact.digest,
  };
  // The kept file must still be the migrated snapshot, or it is not the app.
  // `versions` is the history as the caller holds it NOW, so a version added on
  // PostgreSQL moves this digest too; that is a hosted write and is named as one.
  const keptMatches = async () =>
    (await exportUserApp({ dataDir, versions: options.versions })).digest ===
    fact.digest;
  const keptChanged = () =>
    new EngineError(
      'the desktop app.db no longer matches what was migrated; nothing was changed',
      'refused',
    );
  // No fact, but the marker: a crash after the drop. Finish only when the schema
  // really holds nothing: a recreated or refilled schema is never discarded
  // here (no host can be writing it, the app does not open without the fact).
  if (recorded === null) {
    const held = await countUserRows({ dataDir, database });
    if (held > 0)
      throw new EngineError(
        `the migration record is gone but the schema still holds ${held} rows; an operator must check the schema before the marker is removed; nothing was changed`,
        'refused',
      );
    if (!(await keptMatches())) throw keptChanged();
    rmSync(join(dataDir, POSTGRES_MIGRATION_MARKER), { force: true });
    return result;
  }
  await dropAppSchemaChecked({
    database,
    check: async () => {
      // The hosted side first, so a hosted write is refused by its own name.
      const now = await exportUserApp({
        dataDir,
        database,
        versions: options.versions,
      });
      if (now.digest !== fact.digest) throw new HostedWritesError();
      if (!(await keptMatches())) throw keptChanged();
    },
  });
  rmSync(join(dataDir, POSTGRES_MIGRATION_MARKER), { force: true });
  return result;
}

function parseCompletion(text: string): PostgresMigrationMarker {
  try {
    const m = JSON.parse(text) as Partial<PostgresMigrationMarker>;
    if (m.format === 1 && typeof m.schema === 'string')
      return m as PostgresMigrationMarker;
  } catch {
    // fall through
  }
  throw new EngineError(
    'the migration record in the schema is unreadable; an operator must inspect it',
    'refused',
  );
}
