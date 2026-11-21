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
// 4. record a marker beside `app.db` (atomic rename). The marker is what the
//    host reads to let the app open on PostgreSQL; `app.db` stays as the
//    caller's backup until they remove it themselves.
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
  inspectUserApp,
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

/**
 * True when the app's SQLite file has been moved into `database`'s schema: the
 * marker names this very schema AND the schema still holds a recorded app at the
 * marked version. A dropped or emptied schema is not migrated, so the host never
 * opens a fresh empty schema over an app.
 */
export async function isMigratedToPostgres(
  dataDir: string,
  database: DatabaseConfig,
): Promise<boolean> {
  const marker = readPostgresMigrationMarker(dataDir);
  if (
    !marker ||
    database.kind === 'sqlite' ||
    marker.schema !== database.schema
  )
    return false;
  try {
    const found = await inspectUserApp({ dataDir, database });
    return (
      found.integrity &&
      found.recorded &&
      found.version !== null &&
      found.version >= marker.version &&
      found.tables >= marker.tables
    );
  } catch {
    return false;
  }
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
 * Move the SQLite user app in `dataDir` into `database`'s schema. Safe to
 * rerun at any point: each step is idempotent, a schema holding different data
 * is refused, and `app.db` is never removed or given a user-row change.
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

  // Done already: the schema is the app now (the host may have written to it
  // since), so never compare or move again.
  if (marked && (await isMigratedToPostgres(dataDir, database)))
    return {
      status: 'already-migrated',
      tables: marked.tables,
      rows: marked.rows,
      digest: marked.digest,
    };

  const bundle = await exportUserApp({ dataDir, versions: options.versions });
  await options.onPhase?.('exported');
  await options.provision?.();
  const imported = await importUserApp({ dataDir, database, bundle });
  await options.onPhase?.('imported');
  const verified = await verifyUserApp({ dataDir, database, bundle });
  if (!verified.ok)
    throw new EngineError(
      'the PostgreSQL copy did not match the SQLite app; the app stays closed',
      'refused',
    );
  await options.onPhase?.('verified');

  mkdirSync(dataDir, { recursive: true });
  writeMarker(dataDir, {
    format: 1,
    schema: database.schema as string,
    digest: bundle.digest,
    version: bundle.version,
    tables: imported.tables,
    rows: imported.rows,
    migratedAt: new Date().toISOString(),
  });
  return {
    status: 'migrated',
    tables: imported.tables,
    rows: imported.rows,
    digest: bundle.digest,
  };
}
