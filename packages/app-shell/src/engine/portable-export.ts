// Full-fidelity export and import of one user app's database (app.db), for
// `smrt app export`/`import`, local-to-cloud migration and restore checks.
//
// This is NOT `exportTemplate`/`importTemplate`: those are the owner-facing
// "share my app's shape" commands (no history, no hidden fields, no
// timestamps, row caps). Here every table of app.db travels with every row and
// every column the engine stores (hidden fields and timestamps included), plus
// `_archive`, which is what keeps `undo` working after the move. The version
// history lives in the caller's VersionStore (the shell's models); the caller
// passes it in and the bundle carries it with a digest, so a move can be
// verified and a bundle read on its own.
//
// Open drafts and pending approvals are not part of a move: the caller refuses
// an export while a draft is open (this module only sees the live data).
//
// app.db is opened only through `openAppDatabase` (app-runtime.ts).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openAppDatabase } from './app-runtime.ts';
import { type AppDefinition, validate } from './definition.ts';
import { EngineError } from './errors.ts';
import { AppHost } from './host.ts';
import { MemoryVersionStore, type VersionRecord } from './store.ts';

type Handle = any;

/** Current layout of {@link PortableUserApp}; bump when its shape changes. */
export const PORTABLE_USER_APP_FORMAT = 1;

/** The table the engine rebuilds itself on every start; never carried. */
const META_TABLE = '_app_meta';

/** One table of app.db: every stored (non-generated) column, every row. */
export interface PortableUserAppTable {
  name: string;
  columns: string[];
  /** The table's own CREATE statement, so a table the definition no longer names (an archived one kept for undo) can return. */
  createSql: string;
  /** CREATE INDEX statements of the table. */
  indexSql: string[];
  /** Values as stored; bytes and big integers are tagged (see `encode`). */
  rows: Array<Record<string, unknown>>;
  /** SHA-256 over the canonical rows (order-independent). */
  digest: string;
}

/** A user app's database in a form that survives JSON. */
export interface PortableUserApp {
  format: typeof PORTABLE_USER_APP_FORMAT;
  /** The current definition (`_app_meta.definition`). */
  definition: AppDefinition;
  /** The current version number (`_app_meta.version`). */
  version: number;
  /** Full version history, oldest first, as the caller's store holds it. */
  versions: VersionRecord[];
  /** SHA-256 over the canonical version history. */
  versionsDigest: string;
  tables: PortableUserAppTable[];
  /** SHA-256 over every table's CREATE and CREATE INDEX statements. */
  schemaDigest: string;
  /** SHA-256 over the table names, row counts, table digests and schema digest. */
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
  /** The stored table and index definitions agree with the bundle. */
  schemaMatches: boolean;
}

export interface ExportUserAppOptions {
  /** `<data root>/user-app`: the directory holding `app.db`. */
  dataDir: string;
  /** Version history of the app, oldest first (the caller's VersionStore). */
  versions: VersionRecord[];
}

export interface ImportUserAppOptions {
  dataDir: string;
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

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------- value encoding ----------

const TAG_BYTES = '$bytes';
const TAG_INT = '$int';

/** JSON cannot carry bytes or integers above 2^53; tag them, lossless. */
function encode(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { [TAG_BYTES]: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return { [TAG_INT]: value.toString() };
  if (value instanceof Date) return value.toISOString();
  return value;
}

function decode(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o[TAG_BYTES] === 'string')
      return Buffer.from(o[TAG_BYTES] as string, 'base64');
    if (typeof o[TAG_INT] === 'string') return BigInt(o[TAG_INT] as string);
  }
  return value;
}

/** Stable text of one stored value, the same for the database and a bundle. */
function canon(value: unknown): string {
  const v = decode(value);
  if (v === null || v === undefined) return 'n';
  if (typeof v === 'bigint') return `i${v}`;
  if (typeof v === 'number') return Number.isInteger(v) ? `i${v}` : `r${v}`;
  if (typeof v === 'boolean') return `i${v ? 1 : 0}`;
  if (v instanceof Uint8Array) return `b${Buffer.from(v).toString('base64')}`;
  if (typeof v === 'string') return `t${v}`;
  return `j${JSON.stringify(v)}`;
}

function tableDigest(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const sorted = [...columns].sort();
  const lines = rows
    .map((r) => JSON.stringify(sorted.map((c) => canon(r[c]))))
    .sort();
  return sha256(`${JSON.stringify(sorted)}\n${lines.join('\n')}`);
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

function schemaDigestOf(tables: PortableUserAppTable[]): string {
  return sha256(
    tables
      .map((t) => stableJson([t.name, t.createSql, [...t.indexSql].sort()]))
      .sort()
      .join('\n'),
  );
}

function bundleDigest(
  tables: PortableUserAppTable[],
  vd: string,
  schema: string,
): string {
  return sha256(
    `${vd}\n${schema}\n${tables
      .map((t) => `${t.name}:${t.rows.length}:${t.digest}`)
      .sort()
      .join('\n')}`,
  );
}

// ---------- reading app.db ----------

interface TableData {
  name: string;
  columns: string[];
  createSql: string;
  indexSql: string[];
  rows: Array<Record<string, unknown>>;
}

/** Every real table the move carries (not the engine's meta, not virtual). */
async function tableNames(h: Handle): Promise<string[]> {
  const rows = (
    await h.query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> ? ORDER BY name`,
      [META_TABLE],
    )
  ).rows as Array<{ name: string; sql: string | null }>;
  const virtual = rows.find((r) => /^\s*CREATE\s+VIRTUAL/i.test(r.sql ?? ''));
  if (virtual)
    throw new EngineError(
      `table ${virtual.name} is a virtual table; it cannot be moved`,
      'refused',
    );
  return rows.map((r) => r.name);
}

/** Stored columns only: generated columns are recomputed by the database. */
async function storedColumns(h: Handle, table: string): Promise<string[]> {
  const rows = (
    await h.query(
      `SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid`,
      [table],
    )
  ).rows as Array<{ name: string }>;
  return rows.map((r) => String(r.name));
}

async function readTables(h: Handle): Promise<TableData[]> {
  const out: TableData[] = [];
  for (const name of await tableNames(h)) {
    const columns = await storedColumns(h, name);
    const rows = (
      await h.query(
        `SELECT ${columns.map(q).join(', ')} FROM ${q(name)} ORDER BY rowid`,
      )
    ).rows as Array<Record<string, unknown>>;
    const createSql = String(
      (
        await h.query(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
          [name],
        )
      ).rows[0]?.sql ?? '',
    );
    const indexSql = (
      await h.query(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
        [name],
      )
    ).rows.map((r: { sql: string }) => String(r.sql));
    out.push({ name, columns, createSql, indexSql, rows });
  }
  return out;
}

async function readMeta(
  h: Handle,
): Promise<{ version: number; definition: AppDefinition } | null> {
  const has = (
    await h.query(`SELECT 1 AS x FROM sqlite_master WHERE name = ?`, [
      META_TABLE,
    ])
  ).rows;
  if (!has.length) return null;
  const rows = (await h.query(`SELECT key, value FROM ${META_TABLE}`))
    .rows as Array<{ key: string; value: string }>;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const version = Number(get('version'));
  const raw = get('definition');
  if (!Number.isSafeInteger(version) || !raw) return null;
  return { version, definition: JSON.parse(raw) as AppDefinition };
}

/** One consistent read of the meta record and every table. */
async function readAll(h: Handle): Promise<{
  meta: Awaited<ReturnType<typeof readMeta>>;
  tables: TableData[];
}> {
  return h.transaction(async (tx: Handle) => ({
    meta: await readMeta(tx),
    tables: await readTables(tx),
  }));
}

function packTable(t: TableData): PortableUserAppTable {
  return {
    name: t.name,
    columns: t.columns,
    createSql: t.createSql,
    indexSql: t.indexSql,
    rows: t.rows.map((r) =>
      Object.fromEntries(t.columns.map((c) => [c, encode(r[c])])),
    ),
    digest: tableDigest(t.columns, t.rows),
  };
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
  if (!hasUserAppDatabase(options.dataDir))
    throw new EngineError('there is no user app database to export', 'refused');
  const h = await openAppDatabase(options.dataDir);
  try {
    const read = await readAll(h);
    if (!read.meta)
      throw new EngineError(
        'the user app database has no recorded definition; start the app once before exporting',
        'refused',
      );
    const versions = [...options.versions].sort(
      (a, b) => a.version - b.version,
    );
    checkHistory(versions, read.meta.version, read.meta.definition);
    const tables = read.tables.map(packTable);
    const vd = digestVersionHistory(versions);
    return {
      format: PORTABLE_USER_APP_FORMAT,
      definition: read.meta.definition,
      version: read.meta.version,
      versions,
      versionsDigest: vd,
      tables,
      schemaDigest: schemaDigestOf(tables),
      digest: bundleDigest(tables, vd, schemaDigestOf(tables)),
    };
  } finally {
    await h.close?.();
  }
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
  /** SQLite's own integrity check passed. */
  integrity: boolean;
  /** The recorded version and definition are present and valid. */
  recorded: boolean;
  version: number | null;
  tables: number;
  rows: number;
}

/** Integrity and readability of the user app database in `dataDir`. */
export async function inspectUserApp(options: {
  dataDir: string;
}): Promise<UserAppInspection> {
  if (!hasUserAppDatabase(options.dataDir))
    throw new EngineError('there is no user app database', 'refused');
  const h = await openAppDatabase(options.dataDir);
  try {
    const check = (await h.query('PRAGMA integrity_check')).rows as Array<
      Record<string, unknown>
    >;
    const integrity = check.length === 1 && Object.values(check[0])[0] === 'ok';
    if (!integrity)
      return { integrity, recorded: false, version: null, tables: 0, rows: 0 };
    const read = await readAll(h);
    // Leave no -wal/-shm beside a database a restore is about to move.
    await h.query('PRAGMA wal_checkpoint(TRUNCATE)');
    return {
      integrity,
      recorded:
        read.meta !== null && validate(read.meta.definition).length === 0,
      version: read.meta?.version ?? null,
      tables: read.tables.length,
      rows: read.tables.reduce((n, t) => n + t.rows.length, 0),
    };
  } finally {
    await h.close?.();
  }
}

// ---------- verification ----------

/** A single statement (outside quotes), ignoring one trailing semicolon. */
function isSingleStatement(sql: string): boolean {
  const bare = sql
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, "''")
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;$/, '');
  return !bare.includes(';');
}

/** The statements are one CREATE TABLE of this table and CREATE INDEXes on it. */
function ddlIsSafe(t: PortableUserAppTable): boolean {
  if (typeof t.createSql !== 'string' || !Array.isArray(t.indexSql))
    return false;
  const name = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ref = `(?:"${name}"|\`${name}\`|\\[${name}\\]|${name})`;
  const table = new RegExp(`^\\s*CREATE\\s+TABLE\\s+${ref}\\s*\\(`, 'i');
  const index = new RegExp(
    `^\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\\S+\\s+ON\\s+${ref}\\s*\\(`,
    'i',
  );
  return (
    table.test(t.createSql) &&
    isSingleStatement(t.createSql) &&
    t.indexSql.every(
      (i) => typeof i === 'string' && index.test(i) && isSingleStatement(i),
    )
  );
}

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
    if (names.has(t.name)) problems.push(`table ${t.name} appears twice`);
    names.add(t.name);
    if (t.name.startsWith('sqlite_') || t.name === META_TABLE)
      problems.push(`table ${t.name} may not be carried`);
    if (!Array.isArray(t.rows) || !ddlIsSafe(t))
      return [`the definition of table ${t?.name} is not usable`];
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
  else if (schemaDigestOf(bundle.tables) !== bundle.schemaDigest)
    problems.push('the table definitions do not match their digest');
  else if (
    bundleDigest(bundle.tables, vd, bundle.schemaDigest) !== bundle.digest
  )
    problems.push('the user app does not match its digest');
  try {
    checkHistory(bundle.versions, bundle.version, bundle.definition);
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

/**
 * Compare the user app database in `dataDir` with a bundle: per-table row
 * counts and digests, the tables on either side, and the recorded
 * version/definition. Read-only.
 */
export async function verifyUserApp(options: {
  dataDir: string;
  bundle: PortableUserApp;
}): Promise<UserAppVerification> {
  const { bundle } = options;
  const h = await openAppDatabase(options.dataDir);
  try {
    const read = await readAll(h);
    const actual = new Map(read.tables.map((t) => [t.name, t]));
    const tables: UserAppVerification['tables'] = [];
    const missingTables: string[] = [];
    for (const t of bundle.tables) {
      const found = actual.get(t.name);
      if (!found) {
        missingTables.push(t.name);
        continue;
      }
      const sameColumns =
        stableJson([...found.columns].sort()) ===
        stableJson([...t.columns].sort());
      tables.push({
        name: t.name,
        expectedRows: t.rows.length,
        actualRows: found.rows.length,
        digestMatches:
          sameColumns && tableDigest(found.columns, found.rows) === t.digest,
      });
    }
    const carried = new Set(bundle.tables.map((t) => t.name));
    const extraTables = [...actual.keys()].filter((n) => !carried.has(n));
    // The stored CREATE and index statements too: identical rows under a
    // missing index or a changed constraint is not the same app.
    const carriedNames = new Set(bundle.tables.map((t) => t.name));
    const schemaMatches =
      schemaDigestOf(
        read.tables.filter((t) => carriedNames.has(t.name)).map(packTable),
      ) === bundle.schemaDigest;
    const metaMatches =
      read.meta !== null &&
      read.meta.version === bundle.version &&
      stableJson(read.meta.definition) === stableJson(bundle.definition);
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
  } finally {
    await h.close?.();
  }
}

// ---------- import ----------

function refuse(message: string): never {
  throw new EngineError(message, 'refused');
}

/**
 * Install a bundle as the user app in `dataDir`.
 *
 * Idempotent and resumable: the database is built and verified in a staging
 * directory beside `dataDir` (rebuilt from scratch if a crash left one), then
 * its `app.db` is renamed into place, the last step. A target that already
 * matches the bundle is left alone (`already-imported`); a target holding any
 * other app database is refused, never overwritten. The version history is NOT
 * written here: it travels in the caller's own tables, and the engine reads it
 * from the store when the app starts.
 */
export async function importUserApp(
  options: ImportUserAppOptions,
): Promise<ImportUserAppResult> {
  const { dataDir, bundle } = options;
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
    await fill(stage, bundle);
    // The engine itself must be able to start on what was built (it runs its
    // additive checks and rewrites _app_meta exactly as on any start).
    const store = new MemoryVersionStore();
    for (const v of bundle.versions) await store.append(v);
    await store.setCurrent(bundle.version);
    const host = await AppHost.open(stage, { store });
    await host.close();
    await options.onPhase?.('staged');
    const staged = await verifyUserApp({ dataDir: stage, bundle });
    if (!staged.ok)
      refuse('The staged user app database did not match the bundle.');
    await options.onPhase?.('verified');
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

/**
 * Build the staging database from the bundle: the engine's meta record, every
 * table from its own CREATE statement (so hidden columns and archived tables
 * come back exactly), then every row.
 */
async function fill(stage: string, bundle: PortableUserApp): Promise<void> {
  const h = await openAppDatabase(stage);
  try {
    await h.query('PRAGMA foreign_keys = OFF');
    await h.transaction(async (tx: Handle) => {
      // Opening a database makes core's own `_smrt_*` tables; the rest come
      // from the bundle's statements.
      const present = new Set(await tableNames(tx));
      for (const t of bundle.tables) {
        if (!present.has(t.name)) {
          await tx.query(t.createSql);
          for (const i of t.indexSql) await tx.query(i);
        }
        const have = new Set(await storedColumns(tx, t.name));
        for (const c of t.columns)
          if (!have.has(c))
            refuse(`Table ${t.name} does not define column ${c}.`);
        if (!t.rows.length) continue;
        const sql = `INSERT INTO ${q(t.name)} (${t.columns.map(q).join(', ')}) VALUES (${t.columns.map(() => '?').join(', ')})`;
        for (const row of t.rows)
          await tx.query(
            sql,
            t.columns.map((c) => decode(row[c]) ?? null),
          );
      }
    });
    await h.query('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    await h.close?.();
  }
}
