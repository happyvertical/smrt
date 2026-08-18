/**
 * App-side referential integrity for `SmrtObject.delete()` (#2371).
 *
 * SMRT emits **no** DB-level `FOREIGN KEY` constraints on any engine, so the
 * database will never clean up after a deleted row. Before this module,
 * `delete()` removed the object's own row and nothing else: junction rows,
 * polymorphic association rows, `_smrt_embeddings` and `_smrt_contexts` entries
 * were all left pointing at an id that no longer resolved, and
 * `@foreignKey(..., { onDelete })` was metadata nobody read.
 *
 * This module implements those semantics in the application layer. It mirrors
 * what a DB-level constraint would do, deliberately including the parts that
 * make it *unlike* a model-layer delete:
 *
 * - Cascaded rows are removed with set-based statements. Their `beforeDelete` /
 *   `afterDelete` hooks and interceptors do **not** run, and no change-feed
 *   tombstone is written for them — exactly as `ON DELETE CASCADE` behaves.
 *   Only the object `delete()` was called on runs the full lifecycle.
 * - Everything runs inside a single transaction when the adapter exposes one,
 *   so a partial cascade cannot survive a failure.
 *
 * ## Which references are followed
 *
 * A reference is any `@foreignKey` / `@crossPackageRef` field on a registered
 * class whose target resolves to the deleted object's class (or one of its
 * registered STI ancestors), plus the polymorphic `(metaType, metaId)` pair on
 * {@link SmrtPolymorphicAssociation} subclasses.
 *
 * The action comes from the field's declared `onDelete`. When it is not
 * declared, the default is derived from the referencing class's natural key:
 *
 * | Reference | Default when `onDelete` is absent |
 * |---|---|
 * | Column is part of the referencing class's `conflictColumns`, and is not a `@tenantId()` field | `CASCADE` |
 * | Polymorphic `(metaType, metaId)` association row | `CASCADE` |
 * | Anything else, including every `@tenantId()` field | `NO ACTION` (legacy behaviour — the row is left alone) |
 *
 * The natural-key rule is what makes junction rows work without any
 * per-package annotation: a junction declares
 * `@smrt({ conflictColumns: ['content_id', 'asset_id', 'relationship'] })`, so
 * `content_id` identifies the row and the row cannot outlive the content it
 * links. An ordinary child (`Order.customerId`) is keyed by `(slug, context)`,
 * so it keeps today's behaviour unless it opts in with
 * `@foreignKey(Customer, { onDelete: 'CASCADE' })`.
 *
 * `@tenantId()` fields are excluded from the natural-key rule even though
 * `@happyvertical/smrt-tenancy` leads a tenant-scoped class's *default*
 * `conflictColumns` with the tenant column (#2360): the tenant column scopes
 * ownership, it does not identify the row the way a junction's foreign key
 * does, and it targets a class (`Tenant`) that is virtually always
 * referenced. Without this exclusion, deleting one `Tenant` row would
 * recursively CASCADE through every tenant-scoped table that has not
 * declared its own `conflictColumns` — the overwhelming majority. The field
 * is detected via the `__tenancy.isTenantIdField` marker `@tenantId()`
 * attaches to its own registration (`FieldMeta.__tenancy`, read structurally
 * so `smrt-core` never depends on `smrt-tenancy`). `@tenantId()` exposes no
 * `onDelete` option today, so this cannot currently be overridden per field.
 *
 * @see https://github.com/happyvertical/smrt/issues/2371
 * @module
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { classifyDatabaseError } from './db-errors.js';
import { ConfigurationError, DatabaseError } from './errors.js';
// Type-only: erased at runtime, so it cannot re-enter the
// `registry → object → cascade` import cycle.
import type { ObjectRegistry } from './registry.js';
import { chunkArray, IN_LIST_CHUNK_SIZE } from './utils/chunk.js';
import { toSnakeCase } from './utils/naming.js';

const logger = createLogger({ level: 'info' });

/**
 * Referential action applied to rows pointing at a deleted object.
 *
 * Same vocabulary as SQL's `ON DELETE`, enforced by the framework instead of
 * the engine. `NO ACTION` means "leave the rows alone" — SMRT emits no
 * constraint, so nothing raises.
 */
export type OnDeleteAction = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';

/** Table holding framework-managed per-object memory entries. */
const CONTEXTS_TABLE = '_smrt_contexts';

/** Table holding framework-managed per-object embedding vectors. */
const EMBEDDINGS_TABLE = '_smrt_embeddings';

/**
 * Reserved `_smrt_contexts.owner_id` used by `SmrtCollection.remember()` for
 * collection-scoped memory. A real object id is a UUID and can never equal it,
 * but the guard keeps a malformed id from wiping every sibling's defaults.
 */
const COLLECTION_OWNER_SENTINEL = '__collection__';

/**
 * Maximum number of cascade levels followed from the object `delete()` was
 * called on. A cycle between two classes that both declare `onDelete: 'CASCADE'`
 * is broken by the visited set; this bound catches unbounded *chains*.
 */
const MAX_CASCADE_DEPTH = 10;

/** One reference that must be resolved before the target row can be removed. */
export interface CascadeReference {
  /** Registered name of the class holding the referencing column. */
  className: string;
  /** Table holding the referencing rows. */
  tableName: string;
  /** Field name (camelCase) on the referencing class. */
  fieldName: string;
  /** Column (snake_case) holding the reference. */
  column: string;
  /** Resolved action, never `NO ACTION` (those are dropped from the plan). */
  action: Exclude<OnDeleteAction, 'NO ACTION'>;
  /** `true` when the action was declared rather than derived from the key. */
  declared: boolean;
}

/** A polymorphic association table that can point at any class. */
export interface CascadePolymorphicReference {
  /** Registered name of the association class. */
  className: string;
  /** Table holding the association rows. */
  tableName: string;
}

/** Everything that must happen before rows of one class can be deleted. */
export interface CascadePlan {
  /** Typed `@foreignKey` / `@crossPackageRef` references, action-resolved. */
  references: CascadeReference[];
  /** Polymorphic association tables that may point at this class. */
  polymorphic: CascadePolymorphicReference[];
  /** `meta_type` values that identify this class in an association row. */
  metaTypes: string[];
  /** `true` when nothing references this class and nothing has to be visited. */
  isEmpty: boolean;
}

/**
 * Read-only slice of `ObjectRegistry` this module needs.
 *
 * Taking it as a parameter — rather than importing the registry as a value —
 * keeps `cascade.ts` out of the `registry → object → cascade` import cycle,
 * and lets tests drive the planner from a hand-built registry.
 */
export type CascadeRegistryView = Pick<
  typeof ObjectRegistry,
  | 'getRelationshipMap'
  | 'getFields'
  | 'getConflictColumns'
  | 'getTableName'
  | 'getSelfReferableNames'
  | 'getClass'
>;

const CASCADE_ACTIONS = new Set<OnDeleteAction>([
  'CASCADE',
  'SET NULL',
  'RESTRICT',
  'NO ACTION',
]);

/**
 * Normalize a declared `onDelete` value.
 *
 * Accepts any casing and both `SET NULL` and `SET_NULL`, matching what the
 * schema generator has always carried in the manifest. Returns `undefined` for
 * an unset or unrecognized value so the caller can fall back to the default.
 */
export function normalizeOnDelete(value: unknown): OnDeleteAction | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase().replace(/_/g, ' ');
  return CASCADE_ACTIONS.has(normalized as OnDeleteAction)
    ? (normalized as OnDeleteAction)
    : undefined;
}

function isPolymorphicAssociationClass(fields: Map<string, unknown>): boolean {
  // The three columns `SmrtPolymorphicAssociation` contributes. Requiring all
  // of them keeps an unrelated class that happens to carry a `metaType` from
  // being treated as an association table.
  return fields.has('metaType') && fields.has('metaId') && fields.has('role');
}

/**
 * Build the cascade plan for one class.
 *
 * The plan is derived entirely from registry metadata, so it is valid for any
 * database the class is used against. It is rebuilt per delete rather than
 * cached: registration is incremental (manifests load lazily, tests register
 * classes between cases) and a stale plan would silently skip a table.
 *
 * @param registry - Registry view (`ObjectRegistry` satisfies it)
 * @param className - Class whose incoming references should be resolved
 */
export function buildCascadePlan(
  registry: CascadeRegistryView,
  className: string,
): CascadePlan {
  // `className` is normally already qualified (delete() passes
  // getResolvedQualifiedName()), but a common same-package `@foreignKey('X')`
  // still stores its target as the bare simple name `X`. That still matches:
  // getSelfReferableNames() walks the full ancestor chain (self included) and
  // adds each ancestor's *simple* name via `getClass(ancestor)?.name`, so the
  // simple form is already in the seed set below, not just the loop's
  // qualified-variant augmentation.
  const targetNames = new Set(registry.getSelfReferableNames(className));
  for (const name of [...targetNames]) {
    const qualified = registry.getClass(name)?.qualifiedName;
    if (qualified) targetNames.add(qualified);
  }

  const references: CascadeReference[] = [];
  const polymorphic: CascadePolymorphicReference[] = [];

  for (const [sourceClass, relationships] of registry.getRelationshipMap()) {
    const fields = registry.getFields(sourceClass);

    if (isPolymorphicAssociationClass(fields)) {
      const tableName = registry.getTableName(sourceClass);
      if (tableName) {
        polymorphic.push({ className: sourceClass, tableName });
      }
    }

    if (relationships.length === 0) continue;

    let conflictColumns: Set<string> | undefined;

    for (const relationship of relationships) {
      if (
        relationship.type !== 'foreignKey' &&
        relationship.type !== 'crossPackageRef'
      ) {
        continue;
      }
      if (!targetNames.has(relationship.targetClass)) continue;

      const tableName = registry.getTableName(sourceClass);
      if (!tableName) continue;

      const column = toSnakeCase(relationship.fieldName);
      const declaredAction = normalizeOnDelete(relationship.options?.onDelete);

      if (!conflictColumns) {
        conflictColumns = new Set(registry.getConflictColumns(sourceClass));
      }

      // A `@tenantId()` field is a structural scoping marker, not a
      // junction/ownership key — it lands in `conflictColumns` only because
      // #2360 leads every tenant-scoped class's *default* natural key with
      // the tenant column, not because the referencing row is *identified*
      // by its tenant the way a junction row is identified by its parent.
      // Without this guard, deleting a `Tenant` would silently CASCADE
      // through the tenant column of every tenant-scoped class in the
      // schema that has not declared its own `conflictColumns` — the
      // overwhelming majority. `@tenantId()` exposes no `onDelete` today, so
      // an explicit declaration can never widen this back to CASCADE; that
      // is deliberate until tenant-delete cascade is an explicit decision.
      const isTenantIdField =
        relationship.options?.__tenancy?.isTenantIdField === true;

      const action =
        declaredAction ??
        (!isTenantIdField && conflictColumns.has(column)
          ? 'CASCADE'
          : 'NO ACTION');

      if (action === 'NO ACTION') continue;

      if (
        action === 'SET NULL' &&
        fields.get(relationship.fieldName)?.required
      ) {
        // Fail on the declaration, not later on a NOT NULL violation from the
        // engine — the message there names a column, not the decorator.
        throw ConfigurationError.invalidConfiguration(
          `${sourceClass}.${relationship.fieldName} onDelete: 'SET NULL'`,
          relationship.fieldName,
          "a nullable field (mark it `nullable: true`, or use 'CASCADE' / 'RESTRICT')",
        );
      }

      references.push({
        className: sourceClass,
        tableName,
        fieldName: relationship.fieldName,
        column,
        action,
        declared: declaredAction !== undefined,
      });
    }
  }

  // Both forms are matched deliberately: an association row written before a
  // class was package-qualified still carries the simple `meta_type`. This
  // does not reopen the ambiguous-name hazard `getResolvedQualifiedName()`
  // guards against elsewhere in this module — a same-simple-name sibling
  // class's rows only match if they also share a `meta_id`, and ids are
  // `crypto.randomUUID()`-generated, so a cross-class collision on the
  // *pair* is not a realistic risk (the same argument `deleteSystemRows()`
  // relies on for `_smrt_embeddings` / `_smrt_contexts`, matched by id alone).
  const metaTypes: string[] = [];
  const qualified = registry.getClass(className)?.qualifiedName;
  if (qualified) metaTypes.push(qualified);
  const simple = registry.getClass(className)?.name ?? className;
  if (!metaTypes.includes(simple)) metaTypes.push(simple);

  return {
    references,
    polymorphic,
    metaTypes,
    isEmpty: references.length === 0 && polymorphic.length === 0,
  };
}

/** Per-delete state shared by every level of the cascade. */
interface CascadeContext {
  db: DatabaseInterface;
  registry: CascadeRegistryView;
  /** `table:id` pairs already expanded, so a reference cycle terminates. */
  visited: Set<string>;
  /** Tables touched by the cascade, for read-cache invalidation. */
  affectedTables: Set<string>;
  /**
   * Qualified name of the class that owns each affected table, so the
   * caller can resolve *that* class's own `@smrt({ cache })` config —
   * cross-process cache invalidation is a per-class opt-in, and a table
   * cascaded into belongs to a different class than the one `delete()` was
   * called on.
   */
  affectedTableClasses: Map<string, string>;
}

/** Resolve a registry-recorded class name to its qualified form, when known. */
function toQualifiedClassName(
  registry: CascadeRegistryView,
  className: string,
): string {
  return registry.getClass(className)?.qualifiedName ?? className;
}

/**
 * Build the `where` clause matching `column` against one or more ids.
 *
 * A single id uses equality so the planner can use a plain index; multiple ids
 * use the adapter's `in` operator.
 */
function idPredicate(column: string, ids: string[]): Record<string, unknown> {
  return ids.length === 1 ? { [column]: ids[0] } : { [`${column} in`]: ids };
}

/**
 * Run a cascade statement against a *referencing* table, tolerating the
 * table (or an expected column) not existing in this database.
 *
 * The cascade plan is built from the in-process registry, which can carry a
 * class from any imported package — including one whose table this specific
 * database was never migrated to include (a partially adopted feature, a
 * package pulled in for its types, or, in a test process, a fixture some
 * other test file registered). A missing referencing table trivially has no
 * rows to act on, so the correct behaviour is identical to the table
 * existing and being empty — this must never abort an otherwise valid
 * delete. Any other failure (a real constraint violation, a lock timeout, a
 * genuine SQL error unrelated to the table's existence) still propagates.
 */
async function tolerateMissingTable<T>(
  operation: () => Promise<T>,
  fallback: T,
  context: { table: string; action: string },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (classifyDatabaseError(error).kind === 'undefined_object') {
      logger.warn(
        `Cascade delete skipped ${context.action} on '${context.table}': ` +
          'table or column not found in this database.',
        { error: error instanceof Error ? error.message : String(error) },
      );
      return fallback;
    }
    throw error;
  }
}

async function selectIds(
  db: DatabaseInterface,
  tableName: string,
  column: string,
  ids: string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const batch of chunkArray(ids, IN_LIST_CHUNK_SIZE)) {
    const rows = await tolerateMissingTable(
      () => db.list(tableName, idPredicate(column, batch)),
      [] as Record<string, unknown>[],
      { table: tableName, action: 'CASCADE select' },
    );
    for (const row of rows) {
      const id = row?.id;
      if (typeof id === 'string' && id.length > 0) found.push(id);
    }
  }
  return found;
}

async function deleteByIds(
  db: DatabaseInterface,
  tableName: string,
  ids: string[],
): Promise<void> {
  for (const batch of chunkArray(ids, IN_LIST_CHUNK_SIZE)) {
    await tolerateMissingTable(
      () => db.delete(tableName, idPredicate('id', batch)),
      undefined,
      { table: tableName, action: 'CASCADE delete' },
    );
  }
}

/**
 * Remove the framework-managed side rows owned by the given object ids.
 *
 * `_smrt_contexts` and `_smrt_embeddings` are keyed by `(owner_class, owner_id)`
 * and `(object_class, object_id)` respectively. Both are matched by id alone:
 * ids are UUIDs, and the class column stores the *runtime* constructor name,
 * which for an STI hierarchy is the concrete subclass rather than the class the
 * cascade was planned from.
 *
 * A missing system table is not an error — an application database may predate
 * the table, and losing derived rows must never fail an otherwise valid delete.
 */
async function deleteSystemRows(
  db: DatabaseInterface,
  ids: string[],
): Promise<void> {
  const ownerIds = ids.filter(
    (id) =>
      typeof id === 'string' &&
      id.length > 0 &&
      id !== COLLECTION_OWNER_SENTINEL,
  );
  if (ownerIds.length === 0) return;

  for (const [table, column] of [
    [CONTEXTS_TABLE, 'owner_id'],
    [EMBEDDINGS_TABLE, 'object_id'],
  ] as const) {
    for (const batch of chunkArray(ownerIds, IN_LIST_CHUNK_SIZE)) {
      try {
        await db.delete(table, idPredicate(column, batch));
      } catch (error) {
        logger.warn(
          `Failed to clean ${table} rows during cascade delete: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

/**
 * Resolve every reference pointing at `ids` of `className`, recursively.
 *
 * Does **not** delete the rows identified by `ids` — the caller owns that, so
 * `SmrtObject.delete()` keeps issuing its own final statement and its own
 * lifecycle hooks.
 */
async function resolveReferences(
  ctx: CascadeContext,
  className: string,
  tableName: string,
  ids: string[],
  depth: number,
): Promise<void> {
  const pending = ids.filter((id) => {
    const key = `${tableName}:${id}`;
    if (ctx.visited.has(key)) return false;
    ctx.visited.add(key);
    return true;
  });
  if (pending.length === 0) return;

  if (depth > MAX_CASCADE_DEPTH) {
    throw DatabaseError.constraintViolation(
      `cascade delete from ${className} exceeded the maximum depth of ` +
        `${MAX_CASCADE_DEPTH}; check for a chain of onDelete: 'CASCADE' ` +
        'references that never terminates',
      className,
    );
  }

  const plan = buildCascadePlan(ctx.registry, className);

  // RESTRICT first: refuse before anything has been mutated.
  for (const reference of plan.references) {
    if (reference.action !== 'RESTRICT') continue;
    let remaining = 0;
    for (const batch of chunkArray(pending, IN_LIST_CHUNK_SIZE)) {
      remaining += await tolerateMissingTable(
        () =>
          ctx.db.count(
            reference.tableName,
            idPredicate(reference.column, batch),
          ),
        0,
        { table: reference.tableName, action: 'RESTRICT check' },
      );
      if (remaining > 0) break;
    }
    if (remaining > 0) {
      throw DatabaseError.constraintViolation(
        `${reference.className}.${reference.fieldName} declares ` +
          `onDelete: 'RESTRICT' and ${remaining} row(s) still reference this ` +
          `${className}`,
        reference.column,
      );
    }
  }

  for (const reference of plan.references) {
    if (reference.action === 'SET NULL') {
      for (const batch of chunkArray(pending, IN_LIST_CHUNK_SIZE)) {
        await tolerateMissingTable(
          () =>
            ctx.db.update(
              reference.tableName,
              idPredicate(reference.column, batch),
              { [reference.column]: null },
            ),
          undefined,
          { table: reference.tableName, action: 'SET NULL' },
        );
      }
      ctx.affectedTables.add(reference.tableName);
      ctx.affectedTableClasses.set(
        reference.tableName,
        toQualifiedClassName(ctx.registry, reference.className),
      );
      continue;
    }

    if (reference.action !== 'CASCADE') continue;

    const childIds = await selectIds(
      ctx.db,
      reference.tableName,
      reference.column,
      pending,
    );
    if (childIds.length === 0) continue;

    await resolveReferences(
      ctx,
      reference.className,
      reference.tableName,
      childIds,
      depth + 1,
    );
    await deleteSystemRows(ctx.db, childIds);
    await deleteByIds(ctx.db, reference.tableName, childIds);
    ctx.affectedTables.add(reference.tableName);
    ctx.affectedTableClasses.set(
      reference.tableName,
      toQualifiedClassName(ctx.registry, reference.className),
    );
  }

  for (const association of plan.polymorphic) {
    for (const batch of chunkArray(pending, IN_LIST_CHUNK_SIZE)) {
      const where: Record<string, unknown> = {
        ...idPredicate('meta_id', batch),
      };
      if (plan.metaTypes.length === 1) {
        where.meta_type = plan.metaTypes[0];
      } else {
        where['meta_type in'] = plan.metaTypes;
      }
      const result = await tolerateMissingTable(
        () => ctx.db.delete(association.tableName, where),
        undefined,
        {
          table: association.tableName,
          action: 'polymorphic association cleanup',
        },
      );
      if ((result?.affected ?? 0) > 0) {
        ctx.affectedTables.add(association.tableName);
        ctx.affectedTableClasses.set(
          association.tableName,
          toQualifiedClassName(ctx.registry, association.className),
        );
      }
    }
  }
}

/** Outcome of a cascade run, returned so the caller can invalidate caches. */
export interface CascadeResult {
  /** Tables whose rows were removed or nulled, excluding the target's own. */
  affectedTables: Set<string>;
  /**
   * Qualified class name that owns each entry in {@link affectedTables},
   * where resolvable — lets the caller check *that* class's own
   * cross-process cache config rather than only its own.
   */
  affectedTableClasses: Map<string, string>;
}

/**
 * Resolve every reference to `ids` of `className` and clean their framework
 * side rows, then hand control back so the caller can delete the rows.
 *
 * Callers are expected to run this on a transaction-bound `db` — see
 * {@link runCascadeDelete}, which owns that decision.
 */
export async function cascadeReferencesTo(
  db: DatabaseInterface,
  registry: CascadeRegistryView,
  target: { className: string; tableName: string; ids: string[] },
): Promise<CascadeResult> {
  const ctx: CascadeContext = {
    db,
    registry,
    visited: new Set(),
    affectedTables: new Set(),
    affectedTableClasses: new Map(),
  };
  await resolveReferences(
    ctx,
    target.className,
    target.tableName,
    target.ids,
    0,
  );
  await deleteSystemRows(db, target.ids);
  return {
    affectedTables: ctx.affectedTables,
    affectedTableClasses: ctx.affectedTableClasses,
  };
}

type TransactionCapable = DatabaseInterface & {
  transaction?: <T>(
    this: DatabaseInterface,
    callback: (tx: DatabaseInterface) => Promise<T>,
  ) => Promise<T>;
};

/**
 * Run the cascade and the target row's own deletion atomically.
 *
 * When anything references the class and the adapter exposes `transaction()`,
 * the whole sequence runs inside one — including the caller's `deleteSelf`
 * statement, so a failure part-way through cannot leave the object deleted with
 * its junction rows intact (or vice versa). Adapters without transaction
 * support run the same statements sequentially; this is the documented
 * degradation, not a silent one.
 *
 * When nothing references the class there is nothing to keep consistent, and
 * the transaction is skipped — see the comment on that branch.
 *
 * @param db - Database the object is bound to
 * @param registry - Registry view used to build cascade plans
 * @param target - Class, table and id of the object being deleted
 * @param deleteSelf - Issues the target row's own `DELETE`, on the tx-bound db
 * @returns Tables affected by the cascade, for read-cache invalidation
 */
export async function runCascadeDelete(
  db: DatabaseInterface,
  registry: CascadeRegistryView,
  target: {
    className: string;
    tableName: string;
    /** An unsaved object has none; the cascade is then a no-op. */
    id: string | null | undefined;
  },
  deleteSelf: (db: DatabaseInterface) => Promise<void>,
): Promise<CascadeResult> {
  const ids = target.id ? [target.id] : [];

  // Nothing references this class — the overwhelmingly common case. Opening a
  // transaction to wrap statements that cannot disagree with each other would
  // cost two extra round trips on every delete, and on single-connection
  // adapters it would serialize concurrent deletes behind the transaction
  // queue. Order the two statements instead: the row goes first, so a failure
  // leaves everything as it was, and the derived side rows follow under the
  // best-effort contract they already carry.
  if (buildCascadePlan(registry, target.className).isEmpty) {
    await deleteSelf(db);
    await deleteSystemRows(db, ids);
    return { affectedTables: new Set(), affectedTableClasses: new Map() };
  }

  const run = async (bound: DatabaseInterface): Promise<CascadeResult> => {
    const result = await cascadeReferencesTo(bound, registry, {
      className: target.className,
      tableName: target.tableName,
      ids,
    });
    await deleteSelf(bound);
    return result;
  };

  const transaction = (db as TransactionCapable).transaction;
  if (typeof transaction !== 'function') {
    return run(db);
  }

  return transaction.call<
    DatabaseInterface,
    [(tx: DatabaseInterface) => Promise<CascadeResult>],
    Promise<CascadeResult>
  >(db, run);
}
