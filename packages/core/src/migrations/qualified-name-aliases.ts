/**
 * Stored references to deprecated qualified names (#3338).
 *
 * `@smrt({ previousQualifiedNames })` keeps an old qualified name resolving
 * after a class moves package; it never rewrites stored data. This module is
 * the operator side of that bridge:
 *
 * - {@link countLegacyQualifiedNameReferences} — read-only counts of rows that
 *   still store an old name, which `smrt doctor --db` reports so a consumer
 *   can see when an alias is safe to remove;
 * - {@link backfillLegacyQualifiedNames} — an opt-in, idempotent rewrite of
 *   those rows to the current name. It never runs automatically.
 *
 * Stored references covered:
 *
 * - `meta_type` of every registered `SmrtPolymorphicAssociation` subclass
 *   table (any class can be a polymorphic target, so every alias is counted);
 * - `_meta_type` of an STI table whose family includes an aliased class.
 *
 * Removing an alias is a breaking change for any row this still counts.
 */

import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry';
import { isSmrtCollectionExtendsName } from '../registry/collection-resolution.js';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import {
  IMPLICIT_TENANT_COLUMN,
  IMPLICIT_TENANT_FIELD,
} from '../schema/conflict-target.js';
import { detectEngine } from '../schema/ddl/index.js';
import { tableExists } from '../system/compatibility.js';
import { toSnakeCase } from '../utils/naming.js';
import { BackfillTracker } from './backfill-tracker.js';

/** Prefix of the `_smrt_backfills` marker {@link backfillLegacyQualifiedNames} records. */
export const LEGACY_QUALIFIED_NAMES_BACKFILL_PREFIX =
  '@happyvertical/smrt-core:qualified-name-aliases:v1';

/** One table column that can store a class's qualified name. */
export interface LegacyQualifiedNameTarget {
  /** Registered class that owns the table (qualified when available). */
  className: string;
  table: string;
  /** `meta_type` (polymorphic association) or `_meta_type` (STI discriminator). */
  column: string;
  kind: 'polymorphic' | 'sti';
  /** Deprecated names this column may still hold. */
  aliases: string[];
  /** Tenant column of the table, when tenant-owned. */
  tenantColumn?: string;
  /**
   * Upsert identity columns that include `column`. A rewrite that would
   * duplicate a current-name row on these columns is skipped, never forced.
   */
  conflictColumns?: string[];
}

/** Rows of one target that still store one deprecated name. */
export interface LegacyQualifiedNameReference {
  table: string;
  column: string;
  kind: 'polymorphic' | 'sti';
  alias: string;
  current: string;
  count: number;
}

export interface LegacyQualifiedNameReport {
  /** Declared alias → current qualified name, sorted by alias. */
  aliases: Array<{ alias: string; current: string }>;
  /** Non-zero counts only, sorted by table, column, alias. */
  references: LegacyQualifiedNameReference[];
  /** Sum of `references[].count`. */
  total: number;
  /** Target tables absent from this database (nothing to count). */
  missingTables: string[];
  /** Target tables excluded from a tenant-scoped run (no tenant column). */
  untenantedTables: string[];
}

export interface LegacyQualifiedNameOptions {
  /**
   * Restrict counting/rewriting to one tenant's rows. Tables without a tenant
   * column are then skipped (reported in `untenantedTables`), never touched.
   */
  tenantId?: string;
  /** Engine hint when the adapter URL does not identify it. */
  engineHint?: string;
}

export interface LegacyQualifiedNameBackfillOptions
  extends LegacyQualifiedNameOptions {
  /** Report what would change without writing (no marker is recorded). */
  dryRun?: boolean;
  /** Re-run even when this alias set's marker is already recorded. */
  force?: boolean;
}

export interface LegacyQualifiedNameBackfillResult {
  /** `false` when the marker was already recorded (and `force` was unset) or on a dry run. */
  ran: boolean;
  dryRun: boolean;
  /** The `_smrt_backfills` marker for this alias set and scope. */
  backfillName: string;
  /** Counts before the rewrite. */
  before: LegacyQualifiedNameReport;
  /** Rows rewritten per table/column/alias. */
  rewritten: LegacyQualifiedNameReference[];
  /**
   * Rows left under their old name because the rewrite would duplicate a row
   * already stored under the current name (resolve those by hand, then re-run).
   */
  skippedDuplicates: LegacyQualifiedNameReference[];
  /** Whether the marker was recorded (only when nothing remains in scope). */
  recorded: boolean;
}

type AliasPair = { alias: string; current: string };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aliasPairs(): AliasPair[] {
  return [...ObjectRegistry.getQualifiedNameAliases()].map(
    ([alias, current]) => ({ alias, current }),
  );
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`Refusing to quote unexpected identifier "${name}"`);
  }
  return `"${name}"`;
}

function isPolymorphicAssociationFields(fields: Map<string, unknown>): boolean {
  // Same rule as delete planning (cascade.ts): all three columns
  // `SmrtPolymorphicAssociation` contributes.
  return fields.has('metaType') && fields.has('metaId') && fields.has('role');
}

function safeConflictColumns(className: string): string[] {
  try {
    return ObjectRegistry.getConflictColumns(className).map((column) =>
      toSnakeCase(column),
    );
  } catch {
    return [];
  }
}

function safeTenantColumn(className: string): string | undefined {
  let declared: string | undefined;
  try {
    declared = ObjectRegistry.getTenantColumn(className);
  } catch {
    declared = undefined;
  }
  if (declared) return declared;
  // A `tenantId` field makes rows tenant-owned without any declaration.
  return ObjectRegistry.getFields(className).has(IMPLICIT_TENANT_FIELD)
    ? IMPLICIT_TENANT_COLUMN
    : undefined;
}

/**
 * Every table column that can store a deprecated qualified name, derived from
 * the booted registry. Empty when no class declares `previousQualifiedNames`.
 */
export function collectLegacyQualifiedNameTargets(): LegacyQualifiedNameTarget[] {
  const pairs = aliasPairs();
  if (pairs.length === 0) return [];
  const allAliases = pairs.map((pair) => pair.alias);
  const byKey = new Map<string, LegacyQualifiedNameTarget>();

  const add = (target: LegacyQualifiedNameTarget) => {
    const key = `${target.table}\u0000${target.column}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, target);
      return;
    }
    existing.aliases = [
      ...new Set([...existing.aliases, ...target.aliases]),
    ].sort(compareText);
  };

  for (const className of ObjectRegistry.getQualifiedClassNames()) {
    const registered = ObjectRegistry.getClass(className);
    if (!registered) continue;
    if (isSmrtCollectionExtendsName(registered.extends)) continue;
    if (isFrameworkBaseClass(registered.name, registered.packageName)) continue;
    if (!isPolymorphicAssociationFields(registered.fields)) continue;
    const table = ObjectRegistry.getTableName(className);
    if (!table) continue;
    const conflictColumns = safeConflictColumns(className);
    const tenantColumn = safeTenantColumn(className);
    add({
      className,
      table,
      column: 'meta_type',
      kind: 'polymorphic',
      aliases: [...allAliases].sort(compareText),
      ...(tenantColumn ? { tenantColumn } : {}),
      ...(conflictColumns.includes('meta_type') ? { conflictColumns } : {}),
    });
  }

  for (const { alias, current } of pairs) {
    if (ObjectRegistry.getTableStrategy(current) !== 'sti') continue;
    const table = ObjectRegistry.getTableName(current);
    if (!table) continue;
    const conflictColumns = safeConflictColumns(current);
    const tenantColumn = safeTenantColumn(current);
    add({
      className: current,
      table,
      column: '_meta_type',
      kind: 'sti',
      aliases: [alias],
      ...(tenantColumn ? { tenantColumn } : {}),
      ...(conflictColumns.includes('_meta_type') ? { conflictColumns } : {}),
    });
  }

  return [...byKey.values()].sort(
    (left, right) =>
      compareText(left.table, right.table) ||
      compareText(left.column, right.column),
  );
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function resolveEngine(db: DatabaseInterface, engineHint?: string): string {
  const withConfig = db as DatabaseInterface & {
    config?: { url?: string; type?: string };
    type?: string;
  };
  return detectEngine(
    db.url || withConfig.config?.url || '',
    engineHint || withConfig.type || withConfig.config?.type,
  );
}

async function countTarget(
  db: DatabaseInterface,
  target: LegacyQualifiedNameTarget,
  tenantId: string | undefined,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (target.aliases.length === 0) return counts;
  const column = quoteIdentifier(target.column);
  const params: unknown[] = [...target.aliases];
  let sql =
    `SELECT ${column} AS name, COUNT(*) AS n FROM ${quoteIdentifier(target.table)} ` +
    `WHERE ${column} IN (${target.aliases.map(() => '?').join(', ')})`;
  if (tenantId !== undefined && target.tenantColumn) {
    sql += ` AND ${quoteIdentifier(target.tenantColumn)} = ?`;
    params.push(tenantId);
  }
  sql += ` GROUP BY ${column}`;
  for (const row of rowsOf(await db.query(sql, ...params))) {
    const count = Number(row.n ?? 0);
    if (count > 0) counts.set(String(row.name), count);
  }
  return counts;
}

/**
 * Count rows that still store a deprecated qualified name. Read-only.
 *
 * Absent tables are reported in `missingTables`, not as errors: the registry
 * can carry classes this database never migrated.
 */
export async function countLegacyQualifiedNameReferences(
  db: DatabaseInterface,
  options: LegacyQualifiedNameOptions = {},
): Promise<LegacyQualifiedNameReport> {
  const pairs = aliasPairs();
  const currentByAlias = new Map(pairs.map((pair) => [pair.alias, pair]));
  const report: LegacyQualifiedNameReport = {
    aliases: pairs,
    references: [],
    total: 0,
    missingTables: [],
    untenantedTables: [],
  };
  const engine = resolveEngine(db, options.engineHint);

  for (const target of collectLegacyQualifiedNameTargets()) {
    if (options.tenantId !== undefined && !target.tenantColumn) {
      if (!report.untenantedTables.includes(target.table)) {
        report.untenantedTables.push(target.table);
      }
      continue;
    }
    if (!(await tableExists(db, target.table, engine))) {
      if (!report.missingTables.includes(target.table)) {
        report.missingTables.push(target.table);
      }
      continue;
    }
    const counts = await countTarget(db, target, options.tenantId);
    for (const alias of target.aliases) {
      const count = counts.get(alias) ?? 0;
      if (count === 0) continue;
      report.references.push({
        table: target.table,
        column: target.column,
        kind: target.kind,
        alias,
        current: currentByAlias.get(alias)?.current ?? alias,
        count,
      });
      report.total += count;
    }
  }

  report.missingTables.sort(compareText);
  report.untenantedTables.sort(compareText);
  return report;
}

/**
 * Stable `_smrt_backfills` marker for the declared alias set and scope. A new
 * alias (another model move) produces a new marker, so the backfill runs
 * again for it.
 */
export function legacyQualifiedNamesBackfillName(
  pairs: Array<{ alias: string; current: string }> = aliasPairs(),
  tenantId?: string,
): string {
  const digest = createHash('sha256')
    .update(
      [...pairs]
        .sort((left, right) => compareText(left.alias, right.alias))
        .map(({ alias, current }) => `${alias}=>${current}`)
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 16);
  return tenantId === undefined
    ? `${LEGACY_QUALIFIED_NAMES_BACKFILL_PREFIX}:${digest}`
    : `${LEGACY_QUALIFIED_NAMES_BACKFILL_PREFIX}:${digest}:tenant:${tenantId}`;
}

function nullSafeEquals(engine: string, left: string, right: string): string {
  return engine === 'sqlite'
    ? `${left} IS ${right}`
    : `${left} IS NOT DISTINCT FROM ${right}`;
}

function buildRewriteStatement(
  engine: string,
  target: LegacyQualifiedNameTarget,
  tenantId: string | undefined,
  alias: string,
  current: string,
): { sql: string; params: unknown[] } {
  const table = quoteIdentifier(target.table);
  const column = quoteIdentifier(target.column);
  const params: unknown[] = [current, alias];
  let sql = `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`;
  if (tenantId !== undefined && target.tenantColumn) {
    sql += ` AND ${quoteIdentifier(target.tenantColumn)} = ?`;
    params.push(tenantId);
  }
  const identity = (target.conflictColumns ?? []).filter(
    (name) => name !== target.column,
  );
  if (target.conflictColumns) {
    // Never rewrite a row onto the identity of one already stored under the
    // current name: that is a duplicate association, which an operator must
    // resolve, not a unique-violation the rewrite should provoke.
    const correlated = identity
      .map((name) =>
        nullSafeEquals(
          engine,
          `__smrt_current.${quoteIdentifier(name)}`,
          `${table}.${quoteIdentifier(name)}`,
        ),
      )
      .join(' AND ');
    sql +=
      ` AND NOT EXISTS (SELECT 1 FROM ${table} AS __smrt_current ` +
      `WHERE __smrt_current.${column} = ?${correlated ? ` AND ${correlated}` : ''})`;
    params.push(current);
  }
  return { sql, params };
}

/**
 * Rewrite stored deprecated qualified names to their current names.
 *
 * Opt-in and idempotent: it never runs on its own, rewrites only rows whose
 * value is exactly a declared old name, and records a `_smrt_backfills`
 * marker (per alias set and tenant scope) once nothing in scope remains, so a
 * second call is a no-op unless `force` is set. Rows are rewritten inside one
 * transaction where the adapter provides one; the tenant column, ids and all
 * other values are never touched, and a tenant-scoped run only touches that
 * tenant's rows in tenant-owned tables. A row whose rewrite would duplicate a
 * row already stored under the current name is skipped and reported.
 */
export async function backfillLegacyQualifiedNames(
  db: DatabaseInterface,
  options: LegacyQualifiedNameBackfillOptions = {},
): Promise<LegacyQualifiedNameBackfillResult> {
  const pairs = aliasPairs();
  const backfillName = legacyQualifiedNamesBackfillName(
    pairs,
    options.tenantId,
  );
  const dryRun = options.dryRun === true;
  const before = await countLegacyQualifiedNameReferences(db, options);
  const result: LegacyQualifiedNameBackfillResult = {
    ran: false,
    dryRun,
    backfillName,
    before,
    rewritten: [],
    skippedDuplicates: [],
    recorded: false,
  };
  if (pairs.length === 0 || dryRun) return result;

  const tracker = new BackfillTracker({ db });
  if (!options.force && (await tracker.isApplied(backfillName))) {
    return result;
  }

  const engine = resolveEngine(db, options.engineHint);
  const targets = new Map(
    collectLegacyQualifiedNameTargets().map((target) => [
      `${target.table}\u0000${target.column}`,
      target,
    ]),
  );

  const rewrite = async (handle: DatabaseInterface) => {
    for (const reference of before.references) {
      const target = targets.get(`${reference.table}\u0000${reference.column}`);
      if (!target) continue;
      const { sql, params } = buildRewriteStatement(
        engine,
        target,
        options.tenantId,
        reference.alias,
        reference.current,
      );
      await handle.query(sql, ...params);
    }
  };
  if (typeof db.transaction === 'function') {
    await db.transaction(async (tx) => rewrite(tx as DatabaseInterface));
  } else {
    await rewrite(db);
  }

  const after = await countLegacyQualifiedNameReferences(db, options);
  const remaining = new Map(
    after.references.map((reference) => [
      `${reference.table}\u0000${reference.column}\u0000${reference.alias}`,
      reference,
    ]),
  );
  for (const reference of before.references) {
    const left = remaining.get(
      `${reference.table}\u0000${reference.column}\u0000${reference.alias}`,
    );
    const rewrittenCount = reference.count - (left?.count ?? 0);
    if (rewrittenCount > 0) {
      result.rewritten.push({ ...reference, count: rewrittenCount });
    }
  }
  result.skippedDuplicates = after.references;
  result.ran = true;

  if (after.total === 0) {
    await tracker.recordApplied(backfillName, {
      description:
        'Stored deprecated qualified names rewritten to current names: ' +
        pairs.map(({ alias, current }) => `${alias} -> ${current}`).join(', '),
      packageName: '@happyvertical/smrt-core',
    });
    result.recorded = true;
  }
  return result;
}
