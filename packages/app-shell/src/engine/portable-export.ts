// Full-fidelity export and import of one user app's database, for
// `smrt app export`/`import`, local-to-cloud migration, restore checks and a
// hosted import (#5193). The app runs on SQLite (`app.db`) or in a PostgreSQL
// schema; the bundle is the same either way, so a desktop app moves to a
// hosted one and back.
//
// This is NOT `exportTemplate`/`importTemplate`: those are the owner-facing
// "share my app's shape" commands (no history, no hidden fields, no
// timestamps, row caps). Here every table travels with every row and every
// column the engine stores (hidden fields and timestamps included), plus
// `_archive`, which is what keeps `undo` working after the move. The version
// history lives in the caller's VersionStore (the shell's models); the caller
// passes it in and the bundle carries it with a digest, so a move can be
// verified and a bundle read on its own.
//
// The bundle holds values, never SQL: a target's tables come from the
// definition (the engine builds them as on any start) and, for a table the
// definition no longer names (an archived one kept for undo), from typed
// column descriptors. Nothing of a bundle is ever executed as a statement.
//
// Open drafts and pending approvals are not part of a move: the caller refuses
// an export while a draft is open (this module only sees the live data; a
// PostgreSQL draft's side schema is not carried).
//
// app.db is opened only through `openAppDatabase` (app-runtime.ts).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openAppDatabase } from './app-runtime.ts';
import {
  assertDatabaseConfig,
  claimAppDatabase,
  type DatabaseConfig,
  SQLITE,
  withSchemaAdmin,
} from './db/index.ts';
import {
  assertIdentifier,
  COLUMN_FAMILIES,
  type ColumnFamily,
  type LogicalRow,
  type LogicalValue,
  type PortableColumn,
  type PortableDb,
} from './db/portable.ts';
import {
  lockSchemaForRead,
  postgresPortable,
  scopeForPortable,
} from './db/postgres-portable.ts';
import * as sqlite from './db/sqlite.ts';
import { sqlitePortable } from './db/sqlite-portable.ts';
import { type AppDefinition, tableFor, validate } from './definition.ts';
import { EngineError } from './errors.ts';
import { AppHost } from './host.ts';
import { MemoryVersionStore, type VersionRecord } from './store.ts';

export type { ColumnFamily, PortableColumn } from './db/portable.ts';

/**
 * Current layout of {@link PortableUserApp}; bump when its shape changes.
 * 2: values and typed column descriptors instead of SQLite DDL, so a bundle
 * moves between SQLite and PostgreSQL (format 1 never shipped).
 */
export const PORTABLE_USER_APP_FORMAT = 2;

/** The table the engine rebuilds itself on every start; never carried. */
const META_TABLE = '_app_meta';
const ARCHIVE_TABLE = '_archive';

/** One table: every stored (non-generated) column, every row. */
export interface PortableUserAppTable {
  name: string;
  columns: PortableColumn[];
  /** Values as stored; bytes are tagged (see `encode`), integers are safe JS integers. */
  rows: Array<Record<string, unknown>>;
  /** SHA-256 over the canonical rows (order-independent, the same on either database). */
  digest: string;
}

/** A user app's database in a form that survives JSON. */
export interface PortableUserApp {
  format: typeof PORTABLE_USER_APP_FORMAT;
  /** Which database it was read from (informational). */
  source: 'sqlite' | 'postgres';
  /** The current definition (`_app_meta.definition`). */
  definition: AppDefinition;
  /** The current version number (`_app_meta.version`). */
  version: number;
  /** Full version history, oldest first, as the caller's store holds it. */
  versions: VersionRecord[];
  /** SHA-256 over the canonical version history. */
  versionsDigest: string;
  tables: PortableUserAppTable[];
  /** SHA-256 over the table names, row counts and table digests, and the version history digest. */
  digest: string;
}

/** What a verification pass found. */
export interface UserAppVerification {
  ok: boolean;
  /** Per table: counts and whether the digests agree. */
  tables: Array<{
    name: string;
    expectedRows: number;
    actualRows: number;
    digestMatches: boolean;
  }>;
  /** Tables on one side only. */
  missingTables: string[];
  extraTables: string[];
  /** The current version and definition agree with the bundle. */
  metaMatches: boolean;
  /** Every carried table has exactly the bundle's columns. */
  schemaMatches: boolean;
}

export interface ExportUserAppOptions {
  /** `<data root>/user-app`: the directory holding `app.db` (SQLite). */
  dataDir: string;
  /** Version history of the app, oldest first (the caller's VersionStore). */
  versions: VersionRecord[];
  /**
   * The database the app runs on; SQLite when omitted. PostgreSQL: the host's
   * own config for the app (its schema comes from here, never from a bundle).
   */
  database?: DatabaseConfig;
}

export interface ImportUserAppOptions {
  dataDir: string;
  /**
   * The database to install into; SQLite when omitted. PostgreSQL: the host's
   * config for a schema it provisioned for this app (empty, or holding only the
   * empty tables of an interrupted import). The engine never creates a schema.
   */
  database?: DatabaseConfig;
  bundle: PortableUserApp;
  /** Test seam: observe phases (`staged`, `verified`, `published`). */
  onPhase?: (phase: string) => void | Promise<void>;
}

export interface ImportUserAppResult {
  /** `imported`, or `already-imported` when the target already matched. */
  status: 'imported' | 'already-imported';
  tables: number;
  rows: number;
  digest: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- value encoding and canonical form ----------

const TAG_BYTES = '$bytes';

/** JSON cannot carry bytes; tag them, lossless. */
function encode(value: LogicalValue): unknown {
  if (value instanceof Uint8Array)
    return { [TAG_BYTES]: Buffer.from(value).toString('base64') };
  return value;
}

function decode(value: unknown): LogicalValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o[TAG_BYTES] === 'string')
      return new Uint8Array(Buffer.from(o[TAG_BYTES] as string, 'base64'));
  }
  return value as LogicalValue;
}

const DATE_TEXT =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** A stored date as one instant (UTC ISO), or null when it is not a date. */
function instant(text: string): string | null {
  const m = DATE_TEXT.exec(text);
  if (!m) return null;
  let tz = m[3] ?? 'Z';
  if (/^[+-]\d{2}$/.test(tz)) tz = `${tz}:00`;
  else if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  let time = m[2] ?? '00:00:00';
  if (time.length === 5) time = `${time}:00`;
  const t = Date.parse(`${m[1]}T${time}${tz}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Stable text of one value, the same whichever database it came from: a
 * boolean is a 0/1 integer, a date is its UTC instant, JSON is key-sorted.
 * What the column holds is the BUNDLE's `family`, so a target is judged by the
 * same rule as the source.
 */
function canon(value: unknown, family: ColumnFamily): string {
  const v = decode(value);
  if (v === null || v === undefined) return 'n';
  if (v instanceof Uint8Array) return `b${Buffer.from(v).toString('base64')}`;
  if (typeof v === 'boolean') return `i${v ? 1 : 0}`;
  if (typeof v === 'number') return Number.isInteger(v) ? `i${v}` : `r${v}`;
  if (typeof v === 'string') {
    if (family === 'date') {
      const at = instant(v);
      if (at) return `d${at}`;
    } else if (family === 'json') {
      try {
        return `j${stableJson(JSON.parse(v))}`;
      } catch {
        // not JSON text: compared as text
      }
    }
    return `t${v}`;
  }
  return `j${stableJson(v)}`;
}

function tableDigest(
  columns: PortableColumn[],
  rows: Array<Record<string, unknown>>,
): string {
  const sorted = [...columns].sort((a, b) => (a.name < b.name ? -1 : 1));
  const lines = rows
    .map((r) => JSON.stringify(sorted.map((c) => canon(r[c.name], c.family))))
    .sort();
  return sha256(
    `${JSON.stringify(sorted.map((c) => c.name))}\n${lines.join('\n')}`,
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 over a version history (key-order independent). */
export function digestVersionHistory(versions: VersionRecord[]): string {
  return sha256(stableJson(versions));
}

function bundleDigest(
  tables: Array<{ name: string; rows: unknown[]; digest: string }>,
  vd: string,
): string {
  return sha256(
    `${vd}\n${tables
      .map((t) => `${t.name}:${t.rows.length}:${t.digest}`)
      .sort()
      .join('\n')}`,
  );
}

// ---------- reading a database ----------

interface TableData {
  name: string;
  columns: PortableColumn[];
  rows: LogicalRow[];
}

interface Meta {
  version: number;
  definition: AppDefinition;
}

async function readMeta(db: PortableDb): Promise<Meta | null> {
  const raw = await db.meta();
  if (!raw) return null;
  const version = Number(raw.version);
  if (!Number.isSafeInteger(version) || typeof raw.definition !== 'string')
    return null;
  try {
    return { version, definition: JSON.parse(raw.definition) as AppDefinition };
  } catch {
    return null;
  }
}

/** Columns the app's definition says hold JSON, whatever the database calls them. */
function jsonColumnsOf(
  def: AppDefinition | undefined,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [model, md] of Object.entries(def?.models ?? {})) {
    const names = Object.entries(md.fields ?? {})
      .filter(([, f]) => f.type === 'json')
      .map(([n]) => n);
    if (names.length) out.set(tableFor(model, md), new Set(names));
  }
  return out;
}

/** The columns of a table as the bundle describes them (JSON by the definition). */
async function columnsOf(
  db: PortableDb,
  table: string,
  json: Map<string, Set<string>>,
): Promise<PortableColumn[]> {
  const only = json.get(table);
  return (await db.columns(table)).map((c) =>
    only?.has(c.name) ? { ...c, family: 'json' as const } : c,
  );
}

/** One consistent read of the meta record and every table. */
async function readAll(
  db: PortableDb,
  rows = true,
): Promise<{ meta: Meta | null; tables: TableData[] }> {
  const meta = await readMeta(db);
  const json = jsonColumnsOf(meta?.definition);
  const tables: TableData[] = [];
  for (const name of await db.tables()) {
    assertIdentifier(name, 'table');
    const columns = await columnsOf(db, name, json);
    tables.push({
      name,
      columns,
      rows: rows ? await db.rows(name, columns) : [],
    });
  }
  return { meta, tables };
}

function packTable(t: TableData): PortableUserAppTable {
  return {
    name: t.name,
    columns: t.columns,
    rows: t.rows.map((r) =>
      Object.fromEntries(t.columns.map((c) => [c.name, encode(r[c.name])])),
    ),
    digest: tableDigest(t.columns, t.rows),
  };
}

/** Run `fn` in one transaction on the app's database. */
async function inDatabase<T>(
  dataDir: string,
  database: DatabaseConfig,
  mode: 'read' | 'write',
  fn: (db: PortableDb) => Promise<T>,
): Promise<T> {
  if (database.kind === 'sqlite') {
    const h = await openAppDatabase(dataDir);
    try {
      // Foreign keys off needs to be outside the transaction.
      if (mode === 'write') await sqlite.foreignKeysOff(h);
      return await h.transaction((tx: unknown) => fn(sqlitePortable(tx)));
    } finally {
      await (h as { close?: () => Promise<void> }).close?.();
    }
  }
  assertDatabaseConfig(database);
  return withSchemaAdmin(database, (admin) =>
    admin.transaction(async (tx) => {
      await scopeForPortable(tx, database.schema);
      if (mode === 'read') await lockSchemaForRead(tx, database.schema);
      return fn(postgresPortable(tx));
    }),
  );
}

/** True when the directory holds an app.db the engine has started. */
export function hasUserAppDatabase(dataDir: string): boolean {
  return existsSync(join(dataDir, 'app.db'));
}

// ---------- export ----------

/**
 * Read the whole user app: definition, version history, every table with
 * every row. One read transaction, so the copy is a single consistent state
 * even while the app is serving.
 */
export async function exportUserApp(
  options: ExportUserAppOptions,
): Promise<PortableUserApp> {
  const database = options.database ?? SQLITE;
  if (database.kind === 'sqlite' && !hasUserAppDatabase(options.dataDir))
    throw new EngineError('there is no user app database to export', 'refused');
  const read = await inDatabase(options.dataDir, database, 'read', (db) =>
    readAll(db),
  );
  if (!read.meta)
    throw new EngineError(
      'the user app database has no recorded definition; start the app once before exporting',
      'refused',
    );
  const versions = [...options.versions].sort((a, b) => a.version - b.version);
  checkHistory(versions, read.meta.version, read.meta.definition);
  const tables = read.tables.map(packTable);
  const vd = digestVersionHistory(versions);
  return {
    format: PORTABLE_USER_APP_FORMAT,
    source: database.kind === 'sqlite' ? 'sqlite' : 'postgres',
    definition: read.meta.definition,
    version: read.meta.version,
    versions,
    versionsDigest: vd,
    tables,
    digest: bundleDigest(tables, vd),
  };
}

/** The history must hold the current version and agree with the definition. */
function checkHistory(
  versions: VersionRecord[],
  current: number,
  definition: AppDefinition,
): void {
  const seen = new Set<number>();
  for (const v of versions) {
    if (seen.has(v.version))
      throw new EngineError(`version ${v.version} appears twice`, 'refused');
    seen.add(v.version);
  }
  const rec = versions.find((v) => v.version === current);
  if (!rec)
    throw new EngineError(
      `the version history does not hold the current version ${current}`,
      'refused',
    );
  if (stableJson(rec.definition) !== stableJson(definition))
    throw new EngineError(
      `the stored definition of version ${current} differs from the app database's`,
      'refused',
    );
}

// ---------- inspection ----------

/** What a restore needs to know about a user app database before it is used. */
export interface UserAppInspection {
  /**
   * SQLite's own integrity check passed. On PostgreSQL the server owns page
   * integrity: true when every table could be read.
   */
  integrity: boolean;
  /** The recorded version and definition are present and valid. */
  recorded: boolean;
  version: number | null;
  tables: number;
  rows: number;
}

/** Integrity and readability of the user app database. */
export async function inspectUserApp(options: {
  dataDir: string;
  database?: DatabaseConfig;
}): Promise<UserAppInspection> {
  const database = options.database ?? SQLITE;
  if (database.kind === 'sqlite') {
    if (!hasUserAppDatabase(options.dataDir))
      throw new EngineError('there is no user app database', 'refused');
    const h = await openAppDatabase(options.dataDir);
    try {
      const check = await sqlite.integrityCheck(h);
      const integrity =
        check.length === 1 && Object.values(check[0])[0] === 'ok';
      if (!integrity)
        return {
          integrity,
          recorded: false,
          version: null,
          tables: 0,
          rows: 0,
        };
      const read = await h.transaction(async (tx: unknown) =>
        counts(sqlitePortable(tx)),
      );
      // Leave no -wal/-shm beside a database a restore is about to move.
      await sqlite.checkpoint(h);
      return { integrity, ...read };
    } finally {
      await (h as { close?: () => Promise<void> }).close?.();
    }
  }
  const read = await inDatabase(options.dataDir, database, 'read', counts);
  return { integrity: true, ...read };
}

async function counts(db: PortableDb) {
  const meta = await readMeta(db);
  const names = await db.tables();
  let rows = 0;
  for (const n of names) rows += await db.count(n);
  return {
    recorded: meta !== null && validate(meta.definition).length === 0,
    version: meta?.version ?? null,
    tables: names.length,
    rows,
  };
}

// ---------- verification ----------

function problemsIn(bundle: PortableUserApp): string[] {
  const problems: string[] = [];
  if (!bundle || bundle.format !== PORTABLE_USER_APP_FORMAT)
    return ['unsupported user app format'];
  if (
    !Array.isArray(bundle.tables) ||
    !Array.isArray(bundle.versions) ||
    !Number.isSafeInteger(bundle.version)
  )
    return ['the user app section is incomplete'];
  const defErrors = validate(bundle.definition);
  if (defErrors.length) problems.push(`invalid definition: ${defErrors[0]}`);
  const names = new Set<string>();
  for (const t of bundle.tables) {
    if (!t || typeof t.name !== 'string' || !Array.isArray(t.columns))
      return ['a user app table is malformed'];
    // Names go into SQL: plain identifiers only (a bundle is untrusted input).
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(t.name))
      return [`table name '${t.name}' is not usable`];
    if (names.has(t.name)) problems.push(`table ${t.name} appears twice`);
    names.add(t.name);
    if (t.name.startsWith('sqlite_') || t.name === META_TABLE)
      problems.push(`table ${t.name} may not be carried`);
    const cols = new Set<string>();
    for (const c of t.columns) {
      if (
        !c ||
        typeof c.name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(c.name) ||
        !COLUMN_FAMILIES.includes(c.family) ||
        cols.has(c.name)
      )
        return [`a column of table ${t.name} is not usable`];
      cols.add(c.name);
    }
    if (!Array.isArray(t.rows))
      return [`the rows of table ${t.name} are malformed`];
    for (const row of t.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        return [`a row of table ${t.name} is malformed`];
      for (const [key, v] of Object.entries(row)) {
        const ok =
          cols.has(key) &&
          (v === null ||
            typeof v === 'string' ||
            (typeof v === 'number' && Number.isFinite(v)) ||
            (typeof v === 'object' &&
              !Array.isArray(v) &&
              typeof (v as Record<string, unknown>)[TAG_BYTES] === 'string'));
        if (!ok) return [`a value of table ${t.name}.${key} is not usable`];
        if (
          typeof v === 'number' &&
          Number.isInteger(v) &&
          !Number.isSafeInteger(v)
        )
          return [`table ${t.name}.${key} holds an integer beyond 2^53`];
      }
    }
  }
  return problems;
}

/** Recheck a bundle against itself: its recorded digests match its content. */
export function checkUserAppBundle(bundle: PortableUserApp): string[] {
  const problems = problemsIn(bundle);
  if (problems.length) return problems;
  for (const t of bundle.tables) {
    if (tableDigest(t.columns, t.rows) !== t.digest)
      problems.push(`table ${t.name} does not match its digest`);
  }
  const vd = digestVersionHistory(bundle.versions);
  if (vd !== bundle.versionsDigest)
    problems.push('the version history does not match its digest');
  else if (bundleDigest(bundle.tables, vd) !== bundle.digest)
    problems.push('the user app does not match its digest');
  try {
    checkHistory(bundle.versions, bundle.version, bundle.definition);
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

/** Compare a database with a bundle inside an open transaction. */
async function compare(
  db: PortableDb,
  bundle: PortableUserApp,
): Promise<UserAppVerification> {
  const meta = await readMeta(db);
  const present = new Set(await db.tables());
  const tables: UserAppVerification['tables'] = [];
  const missingTables: string[] = [];
  let schemaMatches = true;
  for (const t of bundle.tables) {
    if (!present.has(t.name)) {
      missingTables.push(t.name);
      continue;
    }
    const actual = await db.columns(t.name);
    const same =
      stableJson(actual.map((c) => c.name).sort()) ===
      stableJson(t.columns.map((c) => c.name).sort());
    if (!same) schemaMatches = false;
    const rows = same ? await db.rows(t.name, actual) : [];
    tables.push({
      name: t.name,
      expectedRows: t.rows.length,
      // Rows are only read when the columns agree.
      actualRows: same ? rows.length : await db.count(t.name),
      digestMatches: same && tableDigest(t.columns, rows) === t.digest,
    });
  }
  const carried = new Set(bundle.tables.map((t) => t.name));
  const extraTables = [...present].filter((n) => !carried.has(n));
  const metaMatches =
    meta !== null &&
    meta.version === bundle.version &&
    stableJson(meta.definition) === stableJson(bundle.definition);
  return {
    ok:
      metaMatches &&
      schemaMatches &&
      missingTables.length === 0 &&
      extraTables.length === 0 &&
      tables.every((t) => t.digestMatches && t.expectedRows === t.actualRows),
    tables,
    missingTables,
    extraTables,
    metaMatches,
    schemaMatches,
  };
}

/**
 * Compare the user app database with a bundle: per-table row counts and
 * digests, the tables on either side, and the recorded version/definition.
 * Read-only. The digests are the same whichever database the bundle came from.
 */
export async function verifyUserApp(options: {
  dataDir: string;
  bundle: PortableUserApp;
  database?: DatabaseConfig;
}): Promise<UserAppVerification> {
  return inDatabase(options.dataDir, options.database ?? SQLITE, 'read', (db) =>
    compare(db, options.bundle),
  );
}

// ---------- import ----------

function refuse(message: string): never {
  throw new EngineError(message, 'refused');
}

/** The engine started on `dataDir`/`database` at the bundle's version, so it builds the current tables. */
async function startEngine(
  dataDir: string,
  database: DatabaseConfig,
  bundle: PortableUserApp,
): Promise<void> {
  const store = new MemoryVersionStore();
  for (const v of bundle.versions) await store.append(v);
  await store.setCurrent(bundle.version);
  const host = await AppHost.open(dataDir, {
    store,
    ...(database.kind === 'sqlite' ? {} : { database }),
  });
  await host.close();
}

/**
 * Put every bundle row into the tables the engine built, creating a table the
 * definition no longer names (an archived one) from its column descriptors.
 * The tables must be empty: a bundle is the whole app, never merged into one.
 */
async function populate(db: PortableDb, bundle: PortableUserApp) {
  const present = new Set(await db.tables());
  for (const t of bundle.tables) {
    if (!present.has(t.name)) {
      if (t.name === ARCHIVE_TABLE) await db.createArchive();
      else await db.create(t.name, t.columns);
    }
    const have = new Set((await db.columns(t.name)).map((c) => c.name));
    for (const c of t.columns)
      if (!have.has(c.name)) await db.addColumn(t.name, c);
    if ((await db.count(t.name)) > 0)
      refuse(`Table ${t.name} already holds rows; nothing was overwritten.`);
    await db.insert(
      t.name,
      t.columns,
      t.rows.map((r) =>
        Object.fromEntries(t.columns.map((c) => [c.name, decode(r[c.name])])),
      ),
    );
    await db.finish(t.name, t.columns);
  }
}

/**
 * Install a bundle as the user app on `database` (SQLite in `dataDir` when
 * omitted).
 *
 * Idempotent and resumable. SQLite: the database is built and verified in a
 * staging directory beside `dataDir` (rebuilt from scratch if a crash left
 * one), then its `app.db` is renamed into place, the last step. PostgreSQL:
 * the engine builds the empty tables in the host's schema, and every row goes
 * in ONE transaction that verifies counts and digests before it commits, so a
 * crash leaves either the empty tables (a rerun fills them) or everything. A
 * target that already matches the bundle is left alone (`already-imported`); a
 * target holding any other data is refused, never overwritten. The version
 * history is NOT written here: it travels in the caller's own tables, and the
 * engine reads it from the store when the app starts.
 */
export async function importUserApp(
  options: ImportUserAppOptions,
): Promise<ImportUserAppResult> {
  const database = options.database ?? SQLITE;
  const { bundle } = options;
  const problems = checkUserAppBundle(bundle);
  if (problems.length)
    refuse(`The user app section is not usable: ${problems[0]}.`);
  const rows = bundle.tables.reduce((n, t) => n + t.rows.length, 0);
  const result = (status: ImportUserAppResult['status']) => ({
    status,
    tables: bundle.tables.length,
    rows,
    digest: bundle.digest,
  });
  return database.kind === 'sqlite'
    ? importSqlite(options, result)
    : importPostgres(options, database, result);
}

async function importSqlite(
  options: ImportUserAppOptions,
  result: (status: ImportUserAppResult['status']) => ImportUserAppResult,
): Promise<ImportUserAppResult> {
  const { dataDir, bundle } = options;
  if (hasUserAppDatabase(dataDir)) {
    const found = await verifyUserApp({ dataDir, bundle });
    if (found.ok) return result('already-imported');
    refuse(
      'The target already holds a different user app database; nothing was overwritten.',
    );
  }

  const stage = `${dataDir}.import-${bundle.digest.slice(0, 12)}`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  try {
    // The engine builds the current tables exactly as on any start; the rows
    // then go in on top.
    await startEngine(stage, SQLITE, bundle);
    await inDatabase(stage, SQLITE, 'write', (db) => populate(db, bundle));
    await options.onPhase?.('staged');
    const staged = await verifyUserApp({ dataDir: stage, bundle });
    if (!staged.ok)
      refuse('The staged user app database did not match the bundle.');
    await options.onPhase?.('verified');
    // Fold the WAL in, so the one file we move holds everything.
    const h = await openAppDatabase(stage);
    try {
      await sqlite.checkpoint(h);
    } finally {
      await (h as { close?: () => Promise<void> }).close?.();
    }
    mkdirSync(dataDir, { recursive: true });
    if (hasUserAppDatabase(dataDir))
      refuse('The target gained a user app database during the import.');
    for (const suffix of ['-wal', '-shm', '-journal'])
      rmSync(join(stage, `app.db${suffix}`), { force: true });
    renameSync(join(stage, 'app.db'), join(dataDir, 'app.db'));
    await options.onPhase?.('published');
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const final = await verifyUserApp({ dataDir, bundle });
  if (!final.ok) refuse('The imported user app database did not verify.');
  mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
  return result('imported');
}

async function importPostgres(
  options: ImportUserAppOptions,
  database: DatabaseConfig,
  result: (status: ImportUserAppResult['status']) => ImportUserAppResult,
): Promise<ImportUserAppResult> {
  const { dataDir, bundle } = options;
  assertDatabaseConfig(database);
  // Where the schema stands: matching (done), empty tables (an interrupted
  // import, or a fresh schema), or someone else's data (refused).
  const state = await inDatabase(dataDir, database, 'read', async (db) => {
    const meta = await readMeta(db);
    const names = await db.tables();
    let populated = 0;
    for (const n of names) populated += await db.count(n);
    return {
      meta,
      tables: names.length,
      populated,
      found: meta && names.length ? await compare(db, bundle) : null,
    };
  });
  if (state.found?.ok) return result('already-imported');
  if (state.populated > 0)
    refuse(
      'The target already holds a different user app database; nothing was overwritten.',
    );
  if (
    state.meta &&
    (state.meta.version !== bundle.version ||
      stableJson(state.meta.definition) !== stableJson(bundle.definition))
  )
    refuse(
      'The target schema already holds a different version of the app; nothing was overwritten.',
    );

  mkdirSync(dataDir, { recursive: true });
  // The engine builds the current (empty) tables from the definition, as on any start.
  await startEngine(dataDir, database, bundle);
  await options.onPhase?.('staged');
  // One host per app while the rows go in; the engine's own start released its claim.
  const release = await claimAppDatabase(database);
  try {
    await inDatabase(dataDir, database, 'write', async (db) => {
      await populate(db, bundle);
      const verified = await compare(db, bundle);
      if (!verified.ok)
        refuse('The imported user app database did not match the bundle.');
      await options.onPhase?.('verified');
    });
  } finally {
    await release?.();
  }
  await options.onPhase?.('published');
  const final = await verifyUserApp({ dataDir, bundle, database });
  if (!final.ok) refuse('The imported user app database did not verify.');
  mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
  return result('imported');
}
