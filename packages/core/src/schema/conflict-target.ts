/**
 * Conflict target (upsert natural key) resolution shared by every schema path
 * and by the runtime (#2360, epic #2382 finding B1/A4).
 *
 * `SmrtObject.save()` upserts a NEW object on
 * `ObjectRegistry.getConflictColumns()`; the schema generator emits ONE unique
 * index over the same columns so `INSERT … ON CONFLICT (…)` binds on every
 * engine. Before #2360 the tenancy interceptor populated `tenant_id` on save
 * but neither the conflict target nor the unique index carried it, so a
 * second tenant creating the same natural key (`slug`, `context`) matched the
 * first tenant's row and `DO UPDATE SET` rewrote its `id` and `tenant_id`
 * (probed: tenant A's row was silently adopted by tenant B).
 *
 * The rule now: **a tenant-scoped class's default conflict target is
 * `[tenantColumn, ...naturalKey]`** on the build path (manifest
 * `decoratorConfig.conflictColumns`, materialized by
 * `ManifestGenerator.normalizeConflictColumns()`) and on the runtime path
 * (`ObjectRegistry.getConflictColumns()`), so schema and upsert agree by
 * construction. Explicit `@smrt({ conflictColumns })` always wins and is
 * never rewritten — a class that declares its own natural key owns it.
 *
 * NULL-tenant rows (`mode: 'optional'` outside a tenant context) keep the
 * SDK's null-aware upsert semantics: `@happyvertical/sql` matches conflict
 * columns with `IS NOT DISTINCT FROM`, so `(NULL, 'widget', '')` updates the
 * existing `(NULL, 'widget', '')` row through the model layer even though the
 * database index treats NULLs as distinct. Global rows therefore dedup among
 * themselves exactly as every row did before, and per-tenant rows dedup per
 * tenant.
 *
 * Index NAMES stay stable across this change — the tenant-led default key
 * keeps `<table>_slug_context_idx` (CTI) / `<table>_slug_context_meta_type_idx`
 * (STI) — so `SchemaComparer`'s same-name shape-drift repair swaps the columns
 * in place (`DROP INDEX` + `CREATE UNIQUE INDEX`) instead of leaving the old
 * global unique index behind to keep blocking cross-tenant duplicates. The new
 * key is a superset of the old one, so creating it cannot fail on existing
 * data.
 */

/** Default natural key of a class-per-table (CTI) object. */
export const DEFAULT_CTI_CONFLICT_COLUMNS: readonly string[] = [
  'slug',
  'context',
];

/**
 * Default natural key of a single-table-inheritance (STI) hierarchy: the
 * discriminator participates in identity so two subtypes may share a slug.
 */
export const DEFAULT_STI_CONFLICT_COLUMNS: readonly string[] = [
  'slug',
  'context',
  '_meta_type',
];

export type ConflictTableStrategy = 'cti' | 'sti';

/**
 * The default conflict target for a table with the given strategy, led by the
 * tenant column when the schema-owning class is tenant-scoped.
 */
export function defaultConflictColumns(
  strategy: ConflictTableStrategy,
  tenantColumn?: string | null,
): string[] {
  const naturalKey =
    strategy === 'sti'
      ? [...DEFAULT_STI_CONFLICT_COLUMNS]
      : [...DEFAULT_CTI_CONFLICT_COLUMNS];
  return tenantColumn ? [tenantColumn, ...naturalKey] : naturalKey;
}

/**
 * Resolve the conflict target of a table.
 *
 * `explicit` (a declared `@smrt({ conflictColumns })`) always wins; otherwise
 * the strategy default, tenant-led when `tenantColumn` is given.
 */
export function resolveConflictColumns(options: {
  explicit?: readonly string[] | null;
  strategy: ConflictTableStrategy;
  tenantColumn?: string | null;
}): string[] {
  if (options.explicit && options.explicit.length > 0) {
    return [...options.explicit];
  }
  return defaultConflictColumns(options.strategy, options.tenantColumn);
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((column, i) => column === b[i]);
}

/**
 * Whether `conflictColumns` is exactly a default natural key (CTI or STI),
 * optionally led by `tenantColumn`. Used to keep the default index names
 * stable when the tenant column is prepended.
 */
export function isDefaultNaturalKey(
  conflictColumns: readonly string[],
  tenantColumn?: string | null,
): boolean {
  const key =
    tenantColumn && conflictColumns[0] === tenantColumn
      ? conflictColumns.slice(1)
      : conflictColumns;
  return (
    sameColumns(key, DEFAULT_CTI_CONFLICT_COLUMNS) ||
    sameColumns(key, DEFAULT_STI_CONFLICT_COLUMNS)
  );
}

/**
 * The stable name of the unique conflict index for `conflictColumns`.
 *
 * - default CTI key `(slug, context)` → `<table>_slug_context_idx`
 * - default STI key `(slug, context, _meta_type)` →
 *   `<table>_slug_context_meta_type_idx`
 * - either default led by the tenant column → the SAME name as without it
 *   (#2360: the differ swaps the columns in place by name)
 * - any custom key → `<table>_<first two columns>_idx` (the historical rule;
 *   a longer key keeps the two-column name so existing databases are not
 *   renamed)
 *
 * @param tenantColumn - the table's tenant column, when the schema owner is
 *   tenant-scoped; only consulted to recognize a tenant-led default key
 */
export function conflictIndexName(
  tableName: string,
  conflictColumns: readonly string[],
  tenantColumn?: string | null,
): string {
  const key =
    tenantColumn &&
    conflictColumns[0] === tenantColumn &&
    isDefaultNaturalKey(conflictColumns, tenantColumn)
      ? conflictColumns.slice(1)
      : conflictColumns;
  if (sameColumns(key, DEFAULT_STI_CONFLICT_COLUMNS)) {
    return `${tableName}_slug_context_meta_type_idx`;
  }
  const nameColumns = key.length > 2 ? key.slice(0, 2) : key;
  return `${tableName}_${nameColumns.join('_')}_idx`;
}

/**
 * Whether an unqualified index over `indexColumns` serves slug lookups
 * (`loadFromSlug()` / `getId()` / `getSavedId()` filter on `slug`, `context`):
 * it leads with `slug`, or it is the tenant-led default key — a tenant-scoped
 * lookup carries the tenant predicate (#2365) and is served by the prefix.
 */
export function servesSlugLookup(
  indexColumns: readonly string[],
  tenantColumn?: string | null,
): boolean {
  if (indexColumns[0] === 'slug') return true;
  return Boolean(
    tenantColumn &&
      indexColumns[0] === tenantColumn &&
      indexColumns[1] === 'slug' &&
      indexColumns[2] === 'context',
  );
}

/**
 * The tenant column of a table, from the schema-owning class's normalized
 * tenant-scoped configuration. Returns `undefined` when the class is not
 * tenant-scoped or the configured field is not among its fields (the field is
 * always injected for tenant-scoped classes; the guard keeps the runtime and
 * build paths honest about the column actually existing).
 *
 * @param tenantField - the configured tenant field name (`tenantScoped.field`,
 *   default `tenantId`), or `undefined` when the class is not tenant-scoped
 * @param hasField - whether the schema owner declares that field
 * @param toColumn - field-name → column-name conversion (`toSnakeCase`)
 */
export function resolveTenantColumn(
  tenantField: string | undefined | null,
  hasField: (fieldName: string) => boolean,
  toColumn: (fieldName: string) => string,
): string | undefined {
  if (!tenantField || !hasField(tenantField)) return undefined;
  return toColumn(tenantField);
}
