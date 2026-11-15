/**
 * Declared table retirements (#5005).
 *
 * Migrate never drops a table it was not told to. A package that stops
 * declaring a model table says so, in its own source, in `package.json`:
 *
 * ```json
 * {
 *   "name": "@acme/orders",
 *   "smrt": {
 *     "retiredTables": [
 *       {
 *         "table": "acme_order_drafts",
 *         "lastOwner": "@acme/orders:OrderDraft",
 *         "since": "1.4.0",
 *         "reason": "Drafts are kept on the order itself.",
 *         "rows": "discard",
 *         "definitions": [
 *           {
 *             "release": "1.3.2",
 *             "columns": { "id": { "type": "UUID", "referenceKind": "id" } }
 *           }
 *         ]
 *       }
 *     ]
 *   }
 * }
 * ```
 *
 * The manifest generator reads that field into the package's manifest
 * (`retiredTables`, each entry carrying its `packageName`). The manifest is
 * what registration, the app's build and `smrt db:migrate` read, so the
 * declaration reaches every install of the package.
 *
 * `definitions` prove the table, not just its name: the columns and types the
 * owning model declared, one entry per published release whose shape a
 * supported database may still have (a table can change shape between
 * releases). Each is written by `scripts/retired-table-facts.mjs definition`
 * from that release's published manifests, never by hand. Migrate drops the
 * live table only when it matches one of them, where a column matches when
 * the ordinary migrate would converge it to the declared type without losing
 * data (`table.retire-mismatch` otherwise).
 *
 * This module is pure and import-free: the manifest generator, the build
 * stamp and the registry all load it.
 */
import type { ColumnDefinition, SQLDataType } from '../schema/types.js';

/** What a package declares. See {@link RetiredTable} for the carried form. */
export interface RetiredTableDeclaration {
  /** The physical table to drop. */
  table: string;
  /**
   * The qualified class (`@scope/pkg:Class`) that last declared the table. Its
   * package is the declaring package: a package retires only its own tables.
   */
  lastOwner: string;
  /** The release that retires the table. */
  since: string;
  /** Why, in a sentence an operator can read. */
  reason: string;
  /**
   * `'discard'` says the rows may be thrown away. Without it a retired table
   * that holds rows stops the migrate and is never dropped.
   */
  rows?: 'discard';
  /**
   * The table as the owning model declared it, one entry per published
   * release whose shape a supported database may hold, each generated from
   * that release's manifests. Migrate drops only a live table that matches
   * one of them. Sorted by release, one entry per release.
   */
  definitions: RetiredTableDefinition[];
}

/** One column of a {@link RetiredTableDefinition}. */
export interface RetiredTableColumn {
  type: SQLDataType;
  /** As the model declared it: decides whether `UUID` and `TEXT` agree. */
  referenceKind?: NonNullable<ColumnDefinition['referenceKind']>;
}

/** A retired table's shape in one release. */
export interface RetiredTableDefinition {
  /** The published release whose manifests it was generated from. */
  release: string;
  /** Column name to its declared type, as that release declared them. */
  columns: Record<string, RetiredTableColumn>;
}

/** A declaration as carried in a manifest and the registry. */
export interface RetiredTable extends RetiredTableDeclaration {
  /** The package that declared the retirement. */
  packageName: string;
}

/** The `package.json` key that holds the declaration (`smrt.retiredTables`). */
export const RETIRED_TABLES_PACKAGE_JSON_KEY = 'retiredTables';

/** A malformed declaration. Raised while the manifest is generated. */
export class RetiredTableDeclarationError extends Error {
  readonly code = 'CONFIG_RETIRED_TABLE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'RetiredTableDeclarationError';
  }
}

/**
 * Lower case only: SQLite and DuckDB compare table names without case, so a
 * mixed-case declaration could name a model's table spelled differently.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const RELEASE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const QUALIFIED_OWNER = /^(@[^/:\s]+\/[^/:\s]+|[^@/:\s]+):([A-Za-z_$][\w$]*)$/;
const DECLARATION_KEYS = new Set([
  'table',
  'lastOwner',
  'since',
  'reason',
  'rows',
  'definitions',
]);
const SQL_TYPES: ReadonlySet<string> = new Set<SQLDataType>([
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'BOOLEAN',
  'JSON',
  'TIMESTAMP',
  'UUID',
]);
const REFERENCE_KINDS: ReadonlySet<string> = new Set([
  'id',
  'foreignKey',
  'crossPackageRef',
  'tenantId',
]);

/** The script that writes one release's entry of a declaration's `definitions`. */
export const RETIRED_TABLE_DEFINITION_SCRIPT =
  'node scripts/retired-table-facts.mjs definition';

/** smrt's own packages: only they may retire a `_smrt_` table. */
export const FRAMEWORK_PACKAGE_PREFIX = '@happyvertical/smrt-';
export const isFrameworkPackage = (packageName: string) =>
  packageName.startsWith(FRAMEWORK_PACKAGE_PREFIX);

/** The package part of a qualified class name, or undefined when malformed. */
export function ownerPackage(lastOwner: string): string | undefined {
  return QUALIFIED_OWNER.exec(lastOwner)
    ? lastOwner.slice(0, lastOwner.lastIndexOf(':'))
    : undefined;
}

/**
 * Check one declaration and attach its package. Plain-words errors: the build
 * fails with the table named. `isSystemTable` lets the caller refuse smrt's own
 * bookkeeping tables, which no package may retire.
 */
export function parseRetiredTable(
  entry: unknown,
  packageName: string,
  isSystemTable: (table: string) => boolean = () => false,
): RetiredTable {
  const where = `Retired table in ${packageName}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new RetiredTableDeclarationError(
      `${where}: each entry must be an object with table, lastOwner, since and reason.`,
    );
  const value = entry as Record<string, unknown>;
  const unknown = Object.keys(value).filter(
    (key) => !DECLARATION_KEYS.has(key),
  );
  const name = typeof value.table === 'string' ? value.table : '(no table)';
  if (unknown.length)
    throw new RetiredTableDeclarationError(
      `${where} ${name}: unknown key(s) ${unknown.join(', ')}. Allowed: ${[...DECLARATION_KEYS].join(', ')}.`,
    );
  if (typeof value.table !== 'string' || !IDENTIFIER.test(value.table))
    throw new RetiredTableDeclarationError(
      `${where}: "table" must be a plain table name (letters, digits and underscores).`,
    );
  if (/^sqlite_/i.test(value.table) || isSystemTable(value.table))
    throw new RetiredTableDeclarationError(
      `${where} ${name}: ${name} is a smrt system table, which no package may retire.`,
    );
  if (value.table.startsWith('_smrt_') && !isFrameworkPackage(packageName))
    throw new RetiredTableDeclarationError(
      `${where} ${name}: only smrt's own packages (${FRAMEWORK_PACKAGE_PREFIX}*) may retire a _smrt_ table.`,
    );
  if (
    typeof value.lastOwner !== 'string' ||
    !QUALIFIED_OWNER.test(value.lastOwner)
  )
    throw new RetiredTableDeclarationError(
      `${where} ${name}: "lastOwner" must be the qualified class that last declared the table, like ${packageName}:ClassName.`,
    );
  if (ownerPackage(value.lastOwner) !== packageName)
    throw new RetiredTableDeclarationError(
      `${where} ${name}: lastOwner ${value.lastOwner} belongs to another package. A package may retire only a table its own models declared.`,
    );
  if (typeof value.since !== 'string' || !RELEASE.test(value.since))
    throw new RetiredTableDeclarationError(
      `${where} ${name}: "since" must be the release that retires the table, like 1.4.0.`,
    );
  if (typeof value.reason !== 'string' || !value.reason.trim())
    throw new RetiredTableDeclarationError(
      `${where} ${name}: "reason" must say why the table is retired.`,
    );
  if (value.rows !== undefined && value.rows !== 'discard')
    throw new RetiredTableDeclarationError(
      `${where} ${name}: "rows" is either left out or the string 'discard'.`,
    );
  const definitions = parseDefinitions(value, `${where} ${name}`);
  return {
    table: value.table,
    lastOwner: value.lastOwner,
    since: value.since,
    reason: value.reason.trim(),
    ...(value.rows === 'discard' ? { rows: 'discard' as const } : {}),
    definitions,
    packageName,
  };
}

const releaseParts = (release: string) =>
  release.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);

/** Release order for sorting definitions: numeric, then the full text. */
function byRelease(a: string, b: string): number {
  const [x, y] = [releaseParts(a), releaseParts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseDefinitions(
  value: Record<string, unknown>,
  where: string,
): RetiredTableDefinition[] {
  const command = `${RETIRED_TABLE_DEFINITION_SCRIPT} --package <name> --table <table> --release <release>`;
  const missing = `${where}: "definitions" must list the table's declared columns, one entry per supported release, each written from that release's published manifests by ${command}. Never write it by hand.`;
  const list = value.definitions;
  if (!Array.isArray(list) || !list.length)
    throw new RetiredTableDeclarationError(missing);
  const parsed = list.map((item) => parseDefinition(item, where, missing));
  const seen = new Set<string>();
  for (const { release } of parsed) {
    if (seen.has(release))
      throw new RetiredTableDeclarationError(
        `${where}: "definitions" lists release ${release} twice. ${missing}`,
      );
    seen.add(release);
  }
  return parsed.sort((a, b) => byRelease(a.release, b.release));
}

function parseDefinition(
  value: unknown,
  where: string,
  missing: string,
): RetiredTableDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RetiredTableDeclarationError(missing);
  const { release, columns, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length)
    throw new RetiredTableDeclarationError(
      `${where}: a definition has unknown key(s) ${Object.keys(rest).join(', ')}. ${missing}`,
    );
  if (typeof release !== 'string' || !RELEASE.test(release))
    throw new RetiredTableDeclarationError(
      `${where}: each definition's "release" must name the published release it was read from. ${missing}`,
    );
  if (
    !columns ||
    typeof columns !== 'object' ||
    Array.isArray(columns) ||
    !Object.keys(columns).length
  )
    throw new RetiredTableDeclarationError(
      `${where}: the definition of release ${release} must list the table's columns. ${missing}`,
    );
  const parsed: Record<string, RetiredTableColumn> = {};
  for (const [column, spec] of Object.entries(columns).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const { type, referenceKind, ...other } = (spec ?? {}) as Record<
      string,
      unknown
    >;
    if (
      !IDENTIFIER.test(column) ||
      typeof spec !== 'object' ||
      Array.isArray(spec) ||
      Object.keys(other).length ||
      typeof type !== 'string' ||
      !SQL_TYPES.has(type) ||
      (referenceKind !== undefined &&
        (typeof referenceKind !== 'string' ||
          !REFERENCE_KINDS.has(referenceKind)))
    )
      throw new RetiredTableDeclarationError(
        `${where}: column ${column} of the definition of release ${release} must be { type, referenceKind? } with a declared smrt type. ${missing}`,
      );
    parsed[column] = {
      type: type as SQLDataType,
      ...(referenceKind
        ? {
            referenceKind:
              referenceKind as RetiredTableColumn['referenceKind'] & string,
          }
        : {}),
    };
  }
  return { release, columns: parsed };
}

/**
 * Check a carried entry (`packageName` included), as it arrives from a
 * manifest, a build description or the registry. Every way into the registry
 * and the build runs this; the planner runs it again.
 */
export function parseCarriedRetiredTable(entry: unknown): RetiredTable {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new RetiredTableDeclarationError(
      'A carried retired-table entry must be an object.',
    );
  const { packageName, ...declaration } = entry as Record<string, unknown>;
  if (typeof packageName !== 'string' || !packageName.trim())
    throw new RetiredTableDeclarationError(
      `Retired table ${String((entry as { table?: unknown }).table)}: the entry names no packageName.`,
    );
  return parseRetiredTable(declaration, packageName);
}

/**
 * The entries a manifest carries, checked. A package's own manifest may carry
 * only its own declarations: an entry labelled with another package is
 * refused, never relabelled. An app's merged manifest (with `consumed`, the
 * packages it depends on) carries its own and its dependencies' entries; an
 * entry of a package it no longer depends on is stale and left out.
 */
export function readManifestRetiredTables(
  manifest: {
    packageName?: string;
    retiredTables?: unknown;
  },
  options: { consumed?: Iterable<string>; source?: string } = {},
): RetiredTable[] {
  const list = manifest.retiredTables;
  if (list === undefined) return [];
  const source = options.source ?? manifest.packageName ?? 'a manifest';
  if (!Array.isArray(list))
    throw new RetiredTableDeclarationError(
      `retiredTables in ${source} must be an array.`,
    );
  const consumed = options.consumed ? new Set(options.consumed) : undefined;
  const out: RetiredTable[] = [];
  for (const item of list) {
    const entry = parseCarriedRetiredTable(item);
    if (entry.packageName === manifest.packageName) {
      out.push(entry);
      continue;
    }
    if (!consumed)
      throw new RetiredTableDeclarationError(
        `Retired table ${entry.table} in ${source} is labelled ${entry.packageName}, not ${manifest.packageName ?? 'its own package'}. A package's manifest carries only its own retirements.`,
      );
    if (consumed.has(entry.packageName)) out.push(entry);
  }
  return mergeRetiredTables(out);
}

/**
 * Read `smrt.retiredTables` from a parsed `package.json`. Absent means none.
 * Every entry is checked; a table listed twice in one package fails.
 */
export function readRetiredTablesFromPackageJson(
  packageJson: unknown,
  packageName: string | undefined,
  isSystemTable?: (table: string) => boolean,
): RetiredTable[] {
  const smrt =
    packageJson && typeof packageJson === 'object'
      ? (packageJson as Record<string, unknown>).smrt
      : undefined;
  const list =
    smrt && typeof smrt === 'object'
      ? (smrt as Record<string, unknown>)[RETIRED_TABLES_PACKAGE_JSON_KEY]
      : undefined;
  if (list === undefined) return [];
  if (!packageName)
    throw new RetiredTableDeclarationError(
      'A package that declares retired tables needs a name in package.json.',
    );
  if (!Array.isArray(list))
    throw new RetiredTableDeclarationError(
      `smrt.${RETIRED_TABLES_PACKAGE_JSON_KEY} in ${packageName} must be an array.`,
    );
  const parsed = list.map((entry) =>
    parseRetiredTable(entry, packageName, isSystemTable),
  );
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (seen.has(entry.table))
      throw new RetiredTableDeclarationError(
        `Retired table ${entry.table} is declared twice in ${packageName}.`,
      );
    seen.add(entry.table);
  }
  return sortRetiredTables(parsed);
}

/**
 * The declarations a manifest's build honours, checked: the manifest's own
 * package's and, in an app's merged manifest, those of the packages it still
 * depends on (`smrtDependencies`). The build description and the build stamp
 * both read this, so they cover the same set.
 */
export function honouredRetiredTables(manifest: {
  packageName?: string;
  retiredTables?: unknown;
  smrtDependencies?: readonly string[];
}): RetiredTable[] {
  return readManifestRetiredTables(
    manifest,
    manifest.smrtDependencies ? { consumed: manifest.smrtDependencies } : {},
  );
}

const byTable = (a: RetiredTable, b: RetiredTable) =>
  a.table < b.table
    ? -1
    : a.table > b.table
      ? 1
      : a.packageName < b.packageName
        ? -1
        : a.packageName > b.packageName
          ? 1
          : 0;

/** Stable order: by table, then package. */
export function sortRetiredTables(
  list: readonly RetiredTable[],
): RetiredTable[] {
  return [...list].sort(byTable);
}

/**
 * Union of several lists (a package's own and its dependencies'), one entry
 * per table and package, in stable order. A repeated entry keeps the first.
 */
export function mergeRetiredTables(
  ...lists: ReadonlyArray<readonly RetiredTable[] | undefined>
): RetiredTable[] {
  const merged = new Map<string, RetiredTable>();
  for (const list of lists)
    for (const entry of list ?? []) {
      const key = `${entry.packageName}\u0000${entry.table}`;
      if (!merged.has(key)) merged.set(key, entry);
    }
  return sortRetiredTables([...merged.values()]);
}

/**
 * What the build's schema stamp covers: the table and whether its rows may be
 * discarded, which is all that changes what migrate does. The reason and
 * release are prose and leave the stamp alone. One entry per table.
 */
export function retiredTablesStampInput(
  list: readonly RetiredTableDeclaration[] | undefined,
): Array<{
  table: string;
  rows: 'discard' | 'keep';
  definitions: Array<Record<string, RetiredTableColumn>>;
}> {
  const byName = new Map<
    string,
    { rows: 'discard' | 'keep'; definitions: Set<string> }
  >();
  for (const entry of list ?? []) {
    const rows: 'discard' | 'keep' =
      entry.rows === 'discard' ? 'discard' : 'keep';
    const prior = byName.get(entry.table);
    // Two packages naming one table agree only if both discard.
    const merged = {
      rows: prior?.rows === 'keep' ? ('keep' as const) : rows,
      definitions: prior?.definitions ?? new Set<string>(),
    };
    // The columns decide whether the live table matches; the release they
    // were read from is provenance.
    for (const definition of entry.definitions ?? [])
      merged.definitions.add(
        JSON.stringify(sortedColumns(definition.columns ?? {})),
      );
    byName.set(entry.table, merged);
  }
  return [...byName]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([table, { rows, definitions }]) => ({
      table,
      rows,
      definitions: [...definitions]
        .sort()
        .map((json) => JSON.parse(json) as Record<string, RetiredTableColumn>),
    }));
}

function sortedColumns(
  columns: Record<string, RetiredTableColumn>,
): Record<string, RetiredTableColumn> {
  return Object.fromEntries(
    Object.keys(columns)
      .sort()
      .map((name) => [
        name,
        {
          type: columns[name].type,
          ...(columns[name].referenceKind
            ? { referenceKind: columns[name].referenceKind }
            : {}),
        },
      ]),
  );
}

// ---------------------------------------------------------------------------
// Registration. One slot on globalThis, like the registry itself, so a bundle
// that loads core twice still sees one list. Cleared by `ObjectRegistry.clear()`.
// ---------------------------------------------------------------------------

const SLOT = Symbol.for('@happyvertical/smrt-core:retired-tables');
type Slot = { [SLOT]?: Map<string, RetiredTable[]> };

function slot(): Map<string, RetiredTable[]> {
  const holder = globalThis as Slot;
  holder[SLOT] ??= new Map();
  return holder[SLOT];
}

/**
 * Register a package's declarations, replacing what it registered before.
 * Each entry is checked and keeps its own `packageName`: one labelled with
 * another package is refused, never relabelled. Internal: packages register
 * through their manifest (`ObjectRegistry.registerPackageManifest`, or
 * `ObjectRegistry.registerManifestRetiredTables` for a loaded manifest file).
 * @internal
 */
export function registerRetiredTables(
  packageName: string,
  list: readonly unknown[] | undefined,
): void {
  if (!list?.length) {
    slot().delete(packageName);
    return;
  }
  const parsed = list.map(parseCarriedRetiredTable);
  for (const entry of parsed)
    if (entry.packageName !== packageName)
      throw new RetiredTableDeclarationError(
        `Retired table ${entry.table} is labelled ${entry.packageName}, but ${packageName} registered it. A package registers only its own retirements.`,
      );
  slot().set(packageName, mergeRetiredTables(parsed));
}

/** Every registered declaration, in stable order. */
export function getRegisteredRetiredTables(): RetiredTable[] {
  return mergeRetiredTables(...slot().values());
}

export function clearRegisteredRetiredTables(): void {
  slot().clear();
}

/** Copy of the registered state, for test isolation. */
export function snapshotRegisteredRetiredTables(): () => void {
  const copy = new Map(
    [...slot()].map(([name, list]) => [
      name,
      list.map((entry) => ({ ...entry })),
    ]),
  );
  return () => {
    const live = slot();
    live.clear();
    for (const [name, list] of copy) live.set(name, list);
  };
}
