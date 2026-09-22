/**
 * Framework-maintained tenant hierarchy materialization (smrt#3036).
 *
 * `Tenant.hierarchyPath` / `hierarchyLevel` are DERIVED from the
 * `parentTenantId` chain. They are an authorization source — the permission
 * resolver walks them for `inheritsToDescendants` and for the declared
 * ancestor-read policy — so the framework, not the consumer, keeps them
 * current:
 *
 * - {@link Tenant.save} recomputes them from the real parent chain on every
 *   save of any Tenant (including STI subclasses and rows created without the
 *   collection helpers) and re-materializes descendants when they change.
 * - {@link materializeTenantHierarchy} (exposed as the
 *   `smrt db:materialize-tenant-hierarchy` CLI command) backfills rows written
 *   before this was framework-maintained.
 *
 * Everything here reads and writes raw rows on the tenants table. That is
 * deliberate: descendants may be STI subclasses, and re-saving them through a
 * base-class instance could clobber subclass columns, while only the two
 * derived columns ever change.
 *
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import { bumpChangeFeed } from '@happyvertical/smrt-core';

const logger = createLogger({ level: 'info' });

/**
 * Maximum allowed depth for tenant hierarchy.
 * Prevents excessively deep trees that could cause performance issues.
 */
export const MAX_TENANT_HIERARCHY_DEPTH = 10;

/** Reasons a tenant hierarchy cannot be (re)materialized. */
export type TenantHierarchyErrorCode =
  | 'CIRCULAR_REFERENCE'
  | 'MAX_DEPTH_EXCEEDED'
  | 'PARENT_NOT_FOUND'
  | 'INVALID_OPERATION';

/**
 * Error thrown when tenant hierarchy operations fail
 */
export class TenantHierarchyError extends Error {
  constructor(
    message: string,
    public readonly code: TenantHierarchyErrorCode,
  ) {
    super(message);
    this.name = 'TenantHierarchyError';
  }
}

/** The derived hierarchy columns of one tenant row. */
export interface TenantHierarchyFields {
  hierarchyPath: string;
  hierarchyLevel: number;
}

/**
 * The minimal database surface these helpers need — satisfied by every
 * `@happyvertical/sql` adapter and transaction handle.
 */
export interface TenantHierarchyDatabase {
  query: (
    sql: string,
    ...vars: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote-free guard: the table name is interpolated, so it must be a plain identifier. */
export function assertTenantTableName(tableName: string): string {
  if (!IDENTIFIER.test(tableName)) {
    throw new TenantHierarchyError(
      `Invalid tenant table name: ${JSON.stringify(tableName)}`,
      'INVALID_OPERATION',
    );
  }
  return tableName;
}

function toId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value);
  return id.length > 0 ? id : null;
}

/** The path a child of `parent` must carry. */
export function childHierarchyFields(
  parentId: string,
  parent: TenantHierarchyFields,
): TenantHierarchyFields {
  return {
    hierarchyPath: parent.hierarchyPath
      ? `${parent.hierarchyPath}/${parentId}`
      : parentId,
    hierarchyLevel: parent.hierarchyLevel + 1,
  };
}

/**
 * Compute a tenant's hierarchy fields from the REAL `parentTenantId` chain,
 * never from any ancestor's materialized path (which may itself be stale).
 *
 * @throws {TenantHierarchyError} `PARENT_NOT_FOUND` when a link is missing,
 *   `CIRCULAR_REFERENCE` when the chain loops or reaches `tenantId`,
 *   `MAX_DEPTH_EXCEEDED` when the tenant would sit at or below
 *   {@link MAX_TENANT_HIERARCHY_DEPTH}.
 */
export async function computeTenantHierarchyFields(
  db: TenantHierarchyDatabase,
  tableName: string,
  tenantId: string | null | undefined,
  parentTenantId: string | null | undefined,
): Promise<TenantHierarchyFields> {
  const table = assertTenantTableName(tableName);
  const ancestors: string[] = [];
  const seen = new Set<string>();
  if (tenantId) seen.add(tenantId);

  let cursor = toId(parentTenantId);
  while (cursor) {
    if (seen.has(cursor)) {
      throw new TenantHierarchyError(
        `Tenant hierarchy for ${tenantId ?? 'a new tenant'} is circular at ${cursor}`,
        'CIRCULAR_REFERENCE',
      );
    }
    if (ancestors.length + 1 >= MAX_TENANT_HIERARCHY_DEPTH) {
      throw new TenantHierarchyError(
        `Maximum hierarchy depth (${MAX_TENANT_HIERARCHY_DEPTH}) exceeded`,
        'MAX_DEPTH_EXCEEDED',
      );
    }
    seen.add(cursor);
    const { rows } = await db.query(
      `SELECT id, parent_tenant_id FROM ${table} WHERE id = ?`,
      cursor,
    );
    const row = rows[0];
    if (!row) {
      throw new TenantHierarchyError(
        `Parent tenant not found: ${cursor}`,
        'PARENT_NOT_FOUND',
      );
    }
    ancestors.unshift(cursor);
    cursor = toId(row.parent_tenant_id);
  }

  return {
    hierarchyPath: ancestors.join('/'),
    hierarchyLevel: ancestors.length,
  };
}

/** One pending descendant rewrite. */
export interface TenantHierarchyUpdate extends TenantHierarchyFields {
  id: string;
}

/**
 * Plan the descendant rewrites implied by `rootId` now carrying `root`.
 * Read-only; walks `parent_tenant_id` links breadth-first, so it works even
 * when descendants were never materialized.
 *
 * @throws {TenantHierarchyError} `MAX_DEPTH_EXCEEDED` when a descendant would
 *   end up too deep, `CIRCULAR_REFERENCE` when the subtree loops.
 */
export async function planDescendantHierarchy(
  db: TenantHierarchyDatabase,
  tableName: string,
  rootId: string,
  root: TenantHierarchyFields,
): Promise<TenantHierarchyUpdate[]> {
  const table = assertTenantTableName(tableName);
  const updates: TenantHierarchyUpdate[] = [];
  const seen = new Set<string>([rootId]);
  let frontier: Array<{ id: string; fields: TenantHierarchyFields }> = [
    { id: rootId, fields: root },
  ];

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const parent of frontier) {
      const { rows } = await db.query(
        `SELECT id, hierarchy_path, hierarchy_level FROM ${table} WHERE parent_tenant_id = ?`,
        parent.id,
      );
      for (const row of rows) {
        const id = toId(row.id);
        if (!id) continue;
        if (seen.has(id)) {
          throw new TenantHierarchyError(
            `Tenant hierarchy below ${rootId} is circular at ${id}`,
            'CIRCULAR_REFERENCE',
          );
        }
        seen.add(id);
        const fields = childHierarchyFields(parent.id, parent.fields);
        if (fields.hierarchyLevel >= MAX_TENANT_HIERARCHY_DEPTH) {
          throw new TenantHierarchyError(
            `Moving would exceed maximum hierarchy depth (${MAX_TENANT_HIERARCHY_DEPTH})`,
            'MAX_DEPTH_EXCEEDED',
          );
        }
        if (
          (row.hierarchy_path ?? '') !== fields.hierarchyPath ||
          Number(row.hierarchy_level) !== fields.hierarchyLevel
        ) {
          updates.push({ id, ...fields });
        }
        next.push({ id, fields });
      }
    }
    frontier = next;
  }

  return updates;
}

/** Write planned hierarchy fields. Touches only the two derived columns. */
export async function applyTenantHierarchyUpdates(
  db: TenantHierarchyDatabase,
  tableName: string,
  updates: readonly TenantHierarchyUpdate[],
): Promise<void> {
  const table = assertTenantTableName(tableName);
  for (const update of updates) {
    await db.query(
      `UPDATE ${table} SET hierarchy_path = ?, hierarchy_level = ? WHERE id = ?`,
      update.hierarchyPath,
      update.hierarchyLevel,
      update.id,
    );
  }
}

/** A stored tenant row, as the backfill planner sees it. */
export interface TenantHierarchyRow {
  id: string;
  parentTenantId: string | null;
  hierarchyPath: string | null;
  hierarchyLevel: number | null;
}

/** A row the planner refuses to materialize, and why. */
export interface TenantHierarchyProblem {
  id: string;
  code: Exclude<TenantHierarchyErrorCode, 'INVALID_OPERATION'>;
  message: string;
}

/** A single planned change: what is stored, and what it must become. */
export interface TenantHierarchyChange extends TenantHierarchyUpdate {
  previousPath: string | null;
  previousLevel: number | null;
}

/** Result of {@link planTenantHierarchy}. */
export interface TenantHierarchyPlan {
  /** Rows examined. */
  total: number;
  /** Rows whose stored fields differ from the parent chain. */
  changes: TenantHierarchyChange[];
  /** Rows whose parent chain is broken; nothing is written while any exist. */
  problems: TenantHierarchyProblem[];
}

/**
 * Pure planner: compute every tenant's hierarchy fields from the
 * `parentTenantId` graph of `rows` and report what differs. Rows whose chain
 * is broken (missing parent, cycle, too deep) are reported as problems rather
 * than guessed at, because the result is an authorization source.
 */
export function planTenantHierarchy(
  rows: readonly TenantHierarchyRow[],
): TenantHierarchyPlan {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const resolved = new Map<
    string,
    TenantHierarchyFields | TenantHierarchyProblem
  >();

  const resolve = (
    id: string,
  ): TenantHierarchyFields | TenantHierarchyProblem => {
    const cached = resolved.get(id);
    if (cached) return cached;

    // Walk up iteratively, then assign top-down.
    const chain: string[] = [];
    const onChain = new Set<string>();
    let cursor: string | null = id;
    let base: TenantHierarchyFields | TenantHierarchyProblem | undefined;
    while (cursor) {
      const known = resolved.get(cursor);
      if (known) {
        base = known;
        break;
      }
      if (onChain.has(cursor)) {
        base = {
          id,
          code: 'CIRCULAR_REFERENCE',
          message: `Tenant ${id} has a circular parent chain at ${cursor}.`,
        };
        break;
      }
      const row = byId.get(cursor);
      if (!row) {
        base = {
          id,
          code: 'PARENT_NOT_FOUND',
          message: `Tenant ${chain[chain.length - 1] ?? id} names missing parent ${cursor}.`,
        };
        break;
      }
      onChain.add(cursor);
      chain.push(cursor);
      cursor = row.parentTenantId;
    }
    if (!base) {
      // `chain` ends at a root.
      const rootId = chain.pop() as string;
      base = { hierarchyPath: '', hierarchyLevel: 0 };
      resolved.set(rootId, base);
      if (rootId === id) return base;
    }

    // Assign from the nearest resolved ancestor down to `id`.
    let parentFields = base;
    for (let i = chain.length - 1; i >= 0; i--) {
      const current = chain[i];
      let fields: TenantHierarchyFields | TenantHierarchyProblem;
      if ('code' in parentFields) {
        fields = { ...parentFields, id: current };
      } else {
        const parentId = byId.get(current)?.parentTenantId as string;
        const child = childHierarchyFields(parentId, parentFields);
        fields =
          child.hierarchyLevel >= MAX_TENANT_HIERARCHY_DEPTH
            ? {
                id: current,
                code: 'MAX_DEPTH_EXCEEDED',
                message: `Tenant ${current} would sit at level ${child.hierarchyLevel}; the maximum depth is ${MAX_TENANT_HIERARCHY_DEPTH}.`,
              }
            : child;
      }
      resolved.set(current, fields);
      parentFields = fields;
    }
    return resolved.get(id) as TenantHierarchyFields | TenantHierarchyProblem;
  };

  const changes: TenantHierarchyChange[] = [];
  const problems: TenantHierarchyProblem[] = [];
  for (const row of rows) {
    const fields = resolve(row.id);
    if ('code' in fields) {
      problems.push({ ...fields, id: row.id });
      continue;
    }
    if (
      (row.hierarchyPath ?? '') !== fields.hierarchyPath ||
      row.hierarchyLevel !== fields.hierarchyLevel
    ) {
      changes.push({
        id: row.id,
        ...fields,
        previousPath: row.hierarchyPath,
        previousLevel: row.hierarchyLevel,
      });
    }
  }

  const byIdOrder = (a: { id: string }, b: { id: string }) =>
    a.id.localeCompare(b.id);
  return {
    total: rows.length,
    changes: changes.sort(byIdOrder),
    problems: problems.sort(byIdOrder),
  };
}

/**
 * Record raw hierarchy rewrites in the change feed through core's documented
 * out-of-band escape hatch, so feed consumers observe that a row's ancestry
 * changed. `rowIds` omitted records one table-level change.
 *
 * Mirrors the framework writer's failure policy: the write already succeeded
 * and must not be un-succeeded by feed bookkeeping, so failures are logged and
 * swallowed. `updated_at` is deliberately NOT bumped — the two columns are
 * derived, and every `Tenant.save()` recomputes them, so a concurrent holder
 * of a stale instance heals rather than conflicts.
 */
export async function recordTenantHierarchyChanges(
  db: Parameters<typeof bumpChangeFeed>[0],
  tableName: string,
  rowIds?: readonly string[],
): Promise<void> {
  const inputs =
    rowIds === undefined
      ? [{ table: tableName, rowId: null }]
      : rowIds.map((rowId) => ({ table: tableName, rowId }));
  // One failed append must not drop the rest: keep recording, and log each
  // row that could not be recorded so it can be identified.
  for (const input of inputs) {
    try {
      await bumpChangeFeed(db, { ...input, operation: 'update' });
    } catch (error) {
      logger.warn('Failed to record tenant hierarchy change in change feed', {
        table: tableName,
        rowId: input.rowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
