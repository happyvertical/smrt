import type { getDatabase } from '@happyvertical/sql';
import {
  applyTenantHierarchyUpdates,
  assertTenantTableName,
  planTenantHierarchy,
  type TenantHierarchyDatabase,
  type TenantHierarchyPlan,
  type TenantHierarchyProblem,
  type TenantHierarchyRow,
} from '../models/tenant-hierarchy.js';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

/** Options for {@link materializeTenantHierarchy}. */
export interface MaterializeTenantHierarchyOptions {
  /** Report what would change without writing. Default `false`. */
  dryRun?: boolean;
  /** The Tenant STI table. Default `'tenants'`. */
  tableName?: string;
}

/** Result of {@link materializeTenantHierarchy}. */
export interface MaterializeTenantHierarchyResult extends TenantHierarchyPlan {
  /** `true` when the planned changes were written. */
  applied: boolean;
}

/**
 * Raised before any row is changed when a tenant's parent chain is broken
 * (missing parent, cycle, or too deep), so an operator can repair
 * `parent_tenant_id` explicitly instead of the backfill guessing at an
 * authorization source.
 */
export class TenantHierarchyMaterializationError extends Error {
  constructor(readonly problems: TenantHierarchyProblem[]) {
    super(
      `Cannot materialize the tenant hierarchy: ${problems.length} tenant(s) have a broken parent chain. ` +
        problems.map((problem) => problem.message).join(' '),
    );
    this.name = 'TenantHierarchyMaterializationError';
  }
}

function toRow(row: Record<string, unknown>): TenantHierarchyRow {
  const id = row.id === null || row.id === undefined ? '' : String(row.id);
  if (!id) {
    throw new Error('Tenant hierarchy backfill found a row without an id.');
  }
  const parent =
    row.parent_tenant_id === null || row.parent_tenant_id === undefined
      ? null
      : String(row.parent_tenant_id);
  const level =
    row.hierarchy_level === null || row.hierarchy_level === undefined
      ? null
      : Number(row.hierarchy_level);
  return {
    id,
    parentTenantId: parent === '' ? null : parent,
    hierarchyPath:
      row.hierarchy_path === null || row.hierarchy_path === undefined
        ? null
        : String(row.hierarchy_path),
    hierarchyLevel: Number.isFinite(level) ? level : null,
  };
}

async function planFrom(
  db: TenantHierarchyDatabase,
  table: string,
): Promise<TenantHierarchyPlan> {
  const { rows } = await db.query(
    `SELECT id, parent_tenant_id, hierarchy_path, hierarchy_level FROM ${table} ORDER BY id`,
  );
  return planTenantHierarchy(rows.map(toRow));
}

/**
 * Backfill `hierarchy_path` / `hierarchy_level` for every tenant from its
 * `parent_tenant_id` chain (smrt#3036).
 *
 * `Tenant.save()` keeps these current from now on; this repairs rows written
 * before the framework maintained them — typically every row created through
 * a path other than `TenantCollection.createChild()`, which left an empty path
 * and level 0 even with a correct parent. Until repaired, both
 * `inheritsToDescendants` and the declared ancestor-read policy fail closed on
 * those tenants.
 *
 * Idempotent: it writes only rows that differ, so a second run reports zero
 * changes. It refuses (writing nothing) when any tenant's chain is broken;
 * `dryRun` reports the same plan, problems included, without throwing.
 * Runs in one transaction when the adapter supports it. Touches only the two
 * derived columns.
 *
 * Exposed as `smrt db:materialize-tenant-hierarchy [--dry-run]`.
 *
 * @throws {TenantHierarchyMaterializationError} when not a dry run and any
 *   tenant's parent chain is broken.
 */
export async function materializeTenantHierarchy(
  db: DatabaseInterface,
  options: MaterializeTenantHierarchyOptions = {},
): Promise<MaterializeTenantHierarchyResult> {
  const table = assertTenantTableName(options.tableName ?? 'tenants');

  if (options.dryRun) {
    return { ...(await planFrom(db, table)), applied: false };
  }

  const run = async (
    handle: TenantHierarchyDatabase,
  ): Promise<MaterializeTenantHierarchyResult> => {
    const plan = await planFrom(handle, table);
    if (plan.problems.length > 0) {
      throw new TenantHierarchyMaterializationError(plan.problems);
    }
    await applyTenantHierarchyUpdates(handle, table, plan.changes);
    return { ...plan, applied: true };
  };

  return db.transaction ? await db.transaction((tx) => run(tx)) : await run(db);
}
