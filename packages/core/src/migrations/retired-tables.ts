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
 *         "rows": "discard"
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
 * This module is pure and import-free: the manifest generator, the build
 * stamp and the registry all load it.
 */

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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RELEASE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const QUALIFIED_OWNER = /^(@[^/:\s]+\/[^/:\s]+|[^@/:\s]+):([A-Za-z_$][\w$]*)$/;
const DECLARATION_KEYS = new Set([
  'table',
  'lastOwner',
  'since',
  'reason',
  'rows',
]);

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
  return {
    table: value.table,
    lastOwner: value.lastOwner,
    since: value.since,
    reason: value.reason.trim(),
    ...(value.rows === 'discard' ? { rows: 'discard' as const } : {}),
    packageName,
  };
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
): Array<{ table: string; rows: 'discard' | 'keep' }> {
  const byName = new Map<string, 'discard' | 'keep'>();
  for (const entry of list ?? []) {
    const rows = entry.rows === 'discard' ? 'discard' : 'keep';
    // Two packages naming one table agree only if both discard.
    byName.set(entry.table, byName.get(entry.table) === 'keep' ? 'keep' : rows);
  }
  return [...byName]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([table, rows]) => ({ table, rows }));
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

/** Register a package's declarations, replacing what it registered before. */
export function registerRetiredTables(
  packageName: string,
  list: readonly RetiredTable[] | undefined,
): void {
  if (!list?.length) {
    slot().delete(packageName);
    return;
  }
  slot().set(
    packageName,
    list.map((entry) => ({ ...entry, packageName })),
  );
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
