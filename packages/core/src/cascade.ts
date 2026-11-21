/**
 * App-side referential integrity for `SmrtObject.delete()` (#2371).
 *
 * Same-package `@foreignKey` fields now emit database constraints where the
 * engine can enforce the declared policy. Cross-package references and older
 * schemas still rely on this application-side path. Before this module,
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
 *   `afterDelete` hooks and interceptors do **not** run. Tracked descendants
 *   get durable sync tombstones. Only the object `delete()` was called on runs
 *   the full lifecycle.
 * - Every row the cascade removes gets a change-feed `delete` entry and every
 *   row a SET NULL reference updates gets an `update` entry, so dependent
 *   tables' versions advance and feed consumers see the change. The ids and
 *   ownership columns come from the cascade statements' own `RETURNING`, each
 *   entry is recorded under that row's own owner (never the parent's), and the
 *   entries are appended on the cascade's transaction handle once every level
 *   has run, so they commit or roll back with it (see
 *   `recordCascadeChanges()` in `change-feed.ts`). What a statement returns
 *   is decided from the catalog first, so the DELETE / UPDATE itself is never
 *   changed by a column the table lacks or the role cannot read; on
 *   PostgreSQL each level's rows are locked `FOR UPDATE` before their
 *   references are scanned.
 * - Every delete runs inside a single transaction when the adapter exposes
 *   one, including cleanup of framework-owned context and embedding rows, so
 *   a partial cascade cannot survive a failure. A `metaType` column can point
 *   at any class at runtime, so a polymorphic association class is always
 *   plausibly relevant.
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
 * | Ordinary same-package reference | `NO ACTION` (deletion is refused while references remain) |
 * | Every `@tenantId()` field | Excluded: tenant scope is not an ownership edge |
 *
 * The natural-key rule is what makes junction rows work without any
 * per-package annotation: a junction declares
 * `@smrt({ conflictColumns: ['content_id', 'asset_id', 'relationship'] })`, so
 * `content_id` identifies the row and the row cannot outlive the content it
 * links. An ordinary child (`Order.customerId`) is keyed by `(slug, context)`,
 * so it defaults to immediate `NO ACTION` unless it opts in with
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
import { type CascadeChange, recordCascadeChanges } from './change-feed.js';
import {
  type ChangeFeedOwnerPlan,
  changeFeedOwnerPlanForClass,
  changeFeedPlanStoredColumns,
  resolveChangeFeedTenantIdFromReturnedRow,
} from './change-feed-tenant.js';
import { classifyDatabaseError } from './db-errors.js';
import {
  isEmbeddedDatabase,
  isFrameworkTransactionHandle,
  usesPostgresDialect,
  withEmbeddedWriteTransaction,
} from './embedded-write-queue.js';
import { ConfigurationError, DatabaseError } from './errors.js';
import { buildWhere } from './host.js';
import {
  isJsonAdapterHandle,
  isKnownNativeDuckDbHandle,
} from './native-duckdb.js';
// Type-only: erased at runtime, so it cannot re-enter the
// `registry → object → cascade` import cycle.
import type { ObjectRegistry } from './registry.js';
import {
  normalizeForeignKeyAction,
  resolveForeignKeyDeleteAction,
} from './schema/foreign-key-policy.js';
import type { ForeignKeyAction } from './schema/types.js';
import {
  type DeletedRowOwners,
  deleteSyncRows,
  nullSyncReference,
  type RawPredicate,
  type SyncRowIdentity,
  withRawPredicate,
} from './sync-tombstones.js';
import { chunkArray, IN_LIST_CHUNK_SIZE } from './utils/chunk.js';
import { toSnakeCase } from './utils/naming.js';

const logger = createLogger({ level: 'info' });

/**
 * Referential action applied to rows pointing at a deleted object.
 *
 * Same vocabulary as SQL's `ON DELETE`, enforced by the framework before the
 * engine. `NO ACTION` is preflighted like an immediate restrictive action so
 * application-side and database-side enforcement agree.
 */
export type OnDeleteAction = ForeignKeyAction;

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
  /** Resolved action. `NO ACTION` is preflighted like an immediate RESTRICT. */
  action: OnDeleteAction;
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
  | 'getSTIBase'
  | 'getDescendants'
  | 'getOwnershipTenantColumn'
  | 'getTableStrategy'
> &
  // Optional: resolves a subtype's inherited fields before its change-feed
  // ownership snapshot. Without it a subtype whose own declarations omit the
  // inherited owner column is unresolved, and its cascaded rows record nothing.
  Partial<Pick<typeof ObjectRegistry, 'getAllFields'>>;

/**
 * Normalize a declared `onDelete` value.
 *
 * Accepts any casing and both `SET NULL` and `SET_NULL`, matching what the
 * schema generator has always carried in the manifest. Returns `undefined` for
 * an unset or unrecognized value so the caller can fall back to the default.
 */
export function normalizeOnDelete(value: unknown): OnDeleteAction | undefined {
  return normalizeForeignKeyAction(value);
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
  // Keep canonical self/ancestor identities from the registry. Never resolve
  // their display aliases again: a shared simple name can select another
  // package. Legacy relationship views without canonical metadata still use
  // the simple aliases already included by getSelfReferableNames().
  const targetNames = new Set(registry.getSelfReferableNames(className));

  const references: CascadeReference[] = [];
  const polymorphic: CascadePolymorphicReference[] = [];
  const visitedBuckets = new Set<unknown>();

  const relationshipMap = registry.getRelationshipMap();
  for (const [sourceClass, relationships] of relationshipMap) {
    const simpleSource = relationships[0]?.sourceClass;
    if (
      simpleSource &&
      sourceClass !== simpleSource &&
      relationshipMap.get(simpleSource) === relationships
    ) {
      continue;
    }
    if (visitedBuckets.has(relationships)) continue;
    visitedBuckets.add(relationships);
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
      const target =
        relationship.targetQualifiedClass === undefined
          ? relationship.targetClass
          : relationship.targetQualifiedClass;
      if (target === null || !targetNames.has(target)) continue;

      // An explicit app-side-only relationship is archival metadata, not a
      // referential-integrity rule. Its identifier is deliberately allowed to
      // outlive the parent, so delete planning must not block, null, or remove
      // the retained row (#2413).
      if (
        relationship.type === 'foreignKey' &&
        relationship.options?.constraint === false
      ) {
        continue;
      }

      const tableName = registry.getTableName(sourceClass);
      if (!tableName) continue;

      const column = toSnakeCase(relationship.fieldName);
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
      if (isTenantIdField) continue;

      const { action, declared } = resolveForeignKeyDeleteAction({
        declared: relationship.options?.onDelete,
        isConflictColumn: conflictColumns.has(column),
        isTenantIdField: false,
        columnName: column,
      });

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
        declared,
      });
    }
  }

  // Both forms are matched deliberately: an association row written before a
  // class was package-qualified still carries the simple `meta_type`. The
  // qualified form alone is unambiguous; the simple-name fallback can still
  // match a same-simple-name sibling class's row if it also shares a
  // `meta_id` — a real, not just theoretical, risk for a class declaring
  // `idType: 'text'` (non-UUID, not guaranteed globally unique), the same gap
  // `deleteSystemRows()` closed for `_smrt_contexts` / `_smrt_embeddings`
  // (review fix) by adding a class-name filter. Closing it here needs the
  // same STI-and-legacy-name-aware filter this module already builds for
  // `deleteSystemRows()` narrowed further to registry-unambiguous simple
  // names; tracked under #2419 alongside the other same-simple-name
  // collision gaps rather than reworked here.
  // A class's deprecated qualified names (#3338) still identify it in rows
  // written before it moved package, so deleting it removes those too.
  const metaTypes: string[] = [];
  const registered = registry.getClass(className);
  const qualified = registered?.qualifiedName;
  if (qualified) metaTypes.push(qualified);
  for (const alias of registered?.config?.previousQualifiedNames ?? []) {
    if (typeof alias === 'string' && !metaTypes.includes(alias)) {
      metaTypes.push(alias);
    }
  }
  const simple = registered?.name ?? className;
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
  /**
   * One final change per physical table and row (`table\0id`), recorded in
   * the feed after the last level. A row two statements touch keeps one
   * entry: `delete` wins over `update`, and an owner that was unresolved, or
   * that two statements disagree on, stays unresolved.
   */
  feed: Map<string, CascadeChange>;
  /** Ownership snapshot per class name, taken before its first statement. */
  classOwners: Map<string, CascadeClassOwner>;
  /** Feed projection per referencing table and class. */
  projections: Map<string, CascadeFeedProjection>;
  /**
   * The rows the caller deletes itself. Every cascade statement on their
   * table excludes them in SQL (`id NOT IN`, compared by the engine with the
   * column's own identity rules), so a self-reference never nulls, removes or
   * records them: the caller's own delete records each once, under the owner
   * its stored row has.
   */
  target: { tableName: string; ids: string[] };
  /** Tables whose changed rows the statement could not identify for the feed. */
  unrecorded: Set<string>;
  /** PostgreSQL: whether the role may lock rows of each table `FOR UPDATE`. */
  lockable: Map<string, boolean>;
  /** PostgreSQL: the target table's `id` column type, for the exclusion cast. */
  targetIdType?: string;
  /** STI hierarchies by base class, for discriminator resolution. */
  stiHierarchies: Map<string, StiHierarchy>;
  /**
   * Owner columns of the caller's target rows read before any cascade
   * statement, by id, to detect a database action that rewrites them.
   */
  targetOwnersBefore?: Map<string, Record<string, unknown>>;
}

/** One class's change-feed ownership snapshot for one cascade. */
interface CascadeClassOwner {
  ctor: unknown;
  plan: ChangeFeedOwnerPlan;
  /** Stored ownership columns; `undefined` when the lookup failed. */
  stored: readonly string[] | undefined;
}

/**
 * What a cascade statement on one referencing table returns for the feed,
 * decided before the statement runs.
 */
interface CascadeFeedProjection {
  className: string;
  /** Rows are resolved per concrete class from their discriminator. */
  sti: boolean;
  /** Ownership columns present in the table and readable by the role. */
  ownerColumns: string[];
  /** `id` is present and readable (always true for a DELETE, which needed it before). */
  idReadable: boolean;
  /** `_meta_type` is present and readable (STI only). */
  metaTypeReadable: boolean;
  /**
   * Ownership snapshots of every class whose rows the table can hold, by
   * qualified class name (the hierarchy resolver's member names).
   */
  members: Map<string, CascadeClassOwner>;
  /** The STI hierarchy a row's discriminator is resolved in (STI only). */
  hierarchy?: StiHierarchy;
}

/**
 * Key of one physical row: the table and the id exactly as the statement
 * returned it (as text). Native UUID columns already return their canonical
 * form; text ids are never folded, so two distinct text ids stay two rows.
 */
function rowKey(table: string, id: string): string {
  return `${table}\u0000${id}`;
}

/** How a cascade statement on one table keeps away from the caller's targets. */
interface TargetExclusion {
  /** `buildWhere` keys (the JSON adapter, which has no SQL). */
  filter: Record<string, unknown>;
  /** One bound JSON array, however many targets there are (SQL engines). */
  raw?: RawPredicate;
}

/**
 * The predicate that keeps a cascade statement on `table` away from the
 * caller's own target rows (nothing for any other table). The engine compares
 * the ids with the column's own identity rules. The whole target list is one
 * bound JSON value, so a batch of any size stays within the engine's limit
 * on bound parameters.
 */
async function excludeTargets(
  ctx: CascadeContext,
  table: string,
): Promise<TargetExclusion> {
  if (table !== ctx.target.tableName || ctx.target.ids.length === 0) {
    return { filter: {} };
  }
  if (isJsonAdapterHandle(ctx.db)) {
    return { filter: { 'id not in': ctx.target.ids } };
  }
  const values = [JSON.stringify(ctx.target.ids)];
  if (usesPostgresDialect(ctx.db)) {
    if (ctx.targetIdType === undefined) {
      const result = await ctx.db.query(
        `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
          WHERE attrelid = to_regclass(format('%I', $1::text))
            AND attname = 'id' AND NOT attisdropped`,
        table,
      );
      const type = String(result.rows[0]?.type ?? 'text');
      ctx.targetIdType = /^[a-z0-9 _(),]+$/i.test(type) ? type : 'text';
    }
    const type = ctx.targetIdType;
    return {
      filter: {},
      raw: {
        sql: (index) =>
          `NOT ("id" = ANY (ARRAY(SELECT jsonb_array_elements_text($${index}::jsonb))::${type}[]))`,
        values,
      },
    };
  }
  if (isKnownNativeDuckDbHandle(ctx.db)) {
    return {
      filter: {},
      raw: {
        sql: () => `"id" NOT IN (SELECT unnest(from_json(?, '["VARCHAR"]')))`,
        values,
      },
    };
  }
  return {
    filter: {},
    raw: { sql: () => `"id" NOT IN (SELECT value FROM json_each(?))`, values },
  };
}

/**
 * Snapshot `className`'s ownership fields once per cascade, after resolving
 * its inherited fields, so the columns a statement returns and the fields its
 * rows are resolved against come from the same snapshot.
 */
async function classOwnerFor(
  ctx: CascadeContext,
  className: string,
): Promise<CascadeClassOwner> {
  const cached = ctx.classOwners.get(className);
  if (cached) return cached;
  try {
    await ctx.registry.getAllFields?.(className);
  } catch {
    // Left unresolved: the ownership lookup then reports the class as such.
  }
  const ctor = ctx.registry.getClass(className)?.constructor;
  const plan = changeFeedOwnerPlanForClass(ctor);
  const owner: CascadeClassOwner = {
    ctor,
    plan,
    stored: changeFeedPlanStoredColumns(plan),
  };
  ctx.classOwners.set(className, owner);
  return owner;
}

/**
 * The subset of `candidates` that `tableName` has and the role can read,
 * from the catalog, before any statement uses them. A column a statement
 * cannot return must never be added to its `RETURNING`: it would make the
 * cascade's own DELETE or UPDATE fail (or, through the missing-table
 * tolerance, skip it) where it used to run. The probes cannot fail on a
 * missing table, so they never abort a PostgreSQL or DuckDB transaction. An
 * adapter with no catalog (the JSON adapter) reads rows instead, and a
 * missing key there is unresolved.
 */
async function readableColumns(
  db: DatabaseInterface,
  tableName: string,
  candidates: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(candidates)];
  if (wanted.length === 0 || isJsonAdapterHandle(db)) return new Set(wanted);
  const found = new Set<string>();
  // A failed lock statement leaves a PostgreSQL transaction aborted, so its
  // own error is the one to report — swallowing it would only surface later
  // as an unexplained "current transaction is aborted" (25P02).
  let lockError: unknown;
  try {
    if (usesPostgresDialect(db)) {
      const probe = async () => {
        const result = await db.query(
          `SELECT attribute.attname AS column_name,
                  has_column_privilege(attribute.attrelid, attribute.attnum, 'SELECT') AS readable
             FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass(format('%I', $1::text))
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND attribute.attname = ANY (string_to_array($2::text, chr(31)))`,
          tableName,
          wanted.join('\u001f'),
        );
        found.clear();
        for (const row of result.rows) {
          if (row.readable === true) found.add(String(row.column_name));
        }
      };
      await probe();
      if (found.size > 0) {
        // Hold the table's ACCESS SHARE lock for the rest of the transaction
        // before the final read of its columns: a concurrent ALTER TABLE
        // (ACCESS EXCLUSIVE) can then not drop a projected column between
        // this probe and the cascade statement that returns it. The read
        // needs only a column the role can already SELECT.
        try {
          await db.query(
            `SELECT 1 FROM "${tableName.replaceAll('"', '""')}" WHERE false`,
          );
        } catch (error) {
          lockError = error;
          throw error;
        }
        await probe();
      }
    } else if (isKnownNativeDuckDbHandle(db)) {
      const result = await db.query(
        'SELECT column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = current_schema()',
        tableName,
      );
      for (const row of result.rows) found.add(String(row.column_name));
    } else {
      const result = await db.query(
        'SELECT name FROM pragma_table_info(?)',
        tableName,
      );
      for (const row of result.rows) found.add(String(row.name));
    }
  } catch (error) {
    if (lockError !== undefined) throw error;
    // Unknown: nothing beyond what the statement already needed is returned.
    return new Set();
  }
  return new Set(wanted.filter((column) => found.has(column)));
}

/**
 * Decide, once per referencing table and class, which columns the cascade
 * statement returns for the feed. For an STI table every class sharing it is
 * snapshotted, so each returned row is resolved against its own concrete
 * class rather than the class that declared the reference.
 */
async function feedProjectionFor(
  ctx: CascadeContext,
  className: string,
  tableName: string,
  sti: boolean,
): Promise<CascadeFeedProjection> {
  const key = `${tableName}\u0000${className}`;
  const cached = ctx.projections.get(key);
  if (cached) return cached;
  // Member names are the hierarchy resolver's (qualified where known), so
  // attribution and traversal resolve a discriminator the same way.
  const hierarchy = sti ? stiHierarchyFor(ctx, className) : undefined;
  const names = hierarchy
    ? new Set([...hierarchy.bySpelling.values()].flatMap((set) => [...set]))
    : new Set([className]);
  const members = new Map<string, CascadeClassOwner>();
  const needed = new Set<string>();
  for (const name of names) {
    const owner = await classOwnerFor(ctx, name);
    members.set(name, owner);
    for (const column of owner.stored ?? []) needed.add(column);
  }
  const available = await readableColumns(ctx.db, tableName, [
    ...needed,
    'id',
    ...(sti ? ['_meta_type'] : []),
  ]);
  const projection: CascadeFeedProjection = {
    className,
    sti,
    ownerColumns: [...needed].filter((column) => available.has(column)),
    idReadable: available.has('id'),
    metaTypeReadable: sti && available.has('_meta_type'),
    members,
    hierarchy,
  };
  ctx.projections.set(key, projection);
  return projection;
}

/**
 * The owner of one returned row: resolved against its concrete class (from
 * the discriminator on an STI table), from the columns the statement
 * returned. `rewrittenColumn` is a column the statement itself set (a SET
 * NULL): when it is one of the row class's ownership columns, the returned
 * value is not the owner the row had, so the row is unresolved.
 */
function returnedRowOwner(
  _ctx: CascadeContext,
  projection: CascadeFeedProjection,
  row: DeletedRowOwners[number],
  rewrittenColumn?: string,
): { tenantId: string | null | undefined; ctor: unknown } {
  let owner: CascadeClassOwner | undefined;
  if (projection.sti) {
    // Exactly one member class, or nothing: an unknown or ambiguous
    // discriminator is unresolved, never a guess.
    const candidates =
      row.metaType && projection.hierarchy
        ? stiCandidates(projection.hierarchy, row.metaType)
        : [];
    owner =
      candidates.length === 1
        ? projection.members.get(candidates[0])
        : undefined;
  } else {
    owner = projection.members.get(projection.className);
  }
  if (!owner) return { tenantId: undefined, ctor: undefined };
  if (
    rewrittenColumn !== undefined &&
    (owner.stored === undefined || owner.stored.includes(rewrittenColumn))
  ) {
    return { tenantId: undefined, ctor: owner.ctor };
  }
  try {
    return {
      tenantId: resolveChangeFeedTenantIdFromReturnedRow(
        owner.plan,
        row.columns,
      ),
      ctor: owner.ctor,
    };
  } catch {
    return { tenantId: undefined, ctor: owner.ctor };
  }
}

/** Queue (or merge) one feed entry per row a cascade statement returned. */
function queueFeedRows(
  ctx: CascadeContext,
  table: string,
  operation: CascadeChange['operation'],
  projection: CascadeFeedProjection,
  rows: DeletedRowOwners | undefined,
  rewrittenColumn?: string,
): void {
  for (const row of rows ?? []) {
    if (!row.id) continue;
    const key = rowKey(table, row.id);
    const { tenantId, ctor } = returnedRowOwner(
      ctx,
      projection,
      row,
      rewrittenColumn,
    );
    const existing = ctx.feed.get(key);
    if (!existing) {
      ctx.feed.set(key, { table, rowId: row.id, operation, tenantId, ctor });
      continue;
    }
    existing.operation =
      existing.operation === 'delete' || operation === 'delete'
        ? 'delete'
        : 'update';
    if (existing.tenantId !== tenantId) existing.tenantId = undefined;
    existing.ctor ??= ctor;
  }
}

/** Resolve a registry-recorded class name to its qualified form, when known. */
function toQualifiedClassName(
  registry: CascadeRegistryView,
  className: string,
): string {
  return registry.getClass(className)?.qualifiedName ?? className;
}

/**
 * Every value `_smrt_contexts.owner_class` / `_smrt_embeddings.object_class`
 * could plausibly hold for a row belonging to an id of `className` (review
 * fix): both name forms (qualified + simple — older rows predate package
 * qualification) of `className` itself, plus every other member of its STI
 * hierarchy sharing its table. A CASCADE-collected id can belong to any
 * concrete STI subclass of the declaring reference, which stamps its own
 * (more specific) runtime class name at write time, not the reference's.
 *
 * Narrowing by this set — instead of matching by id alone — closes a
 * cross-class collision: two unrelated classes using `idType: 'text'`
 * (non-UUID, not guaranteed globally unique) could otherwise share an id
 * value and have one's `remember()`/embeddings rows deleted by the other's
 * cascade.
 */
function ownerClassCandidates(
  registry: CascadeRegistryView,
  className: string,
): string[] {
  const stiBase = registry.getSTIBase(className) ?? className;
  const members = new Set<string>([
    className,
    stiBase,
    ...registry.getDescendants(stiBase),
  ]);

  const names = new Set<string>();
  for (const member of members) {
    names.add(member);
    const registered = registry.getClass(member);
    if (registered?.qualifiedName) names.add(registered.qualifiedName);
    if (registered?.name) names.add(registered.name);
  }
  return [...names];
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
 * Count of cascade write statements issued per transaction-bound handle
 * (#2824). A joined no-savepoint transaction is aborted on failure only when
 * the cascade actually changed something in it; a refusal raised before any
 * write — the RESTRICT / NO ACTION preflight — leaves the caller's transaction
 * usable, exactly as a refusal on a savepoint-capable engine would.
 */
const cascadeWrites = new WeakMap<DatabaseInterface, number>();

/**
 * Record a cascade write on `db`. A result that reports `affected: 0` changed
 * nothing; anything else (including adapters that report no count) counts.
 */
export function recordCascadeWrite<T>(db: DatabaseInterface, result: T): T {
  const affected = (result as { affected?: unknown } | undefined)?.affected;
  if (typeof affected !== 'number' || affected > 0) {
    cascadeWrites.set(db, (cascadeWrites.get(db) ?? 0) + 1);
  }
  return result;
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

/**
 * System-table cleanup may ignore an absent table for databases created before
 * that subsystem existed, but never a missing column in a table that does
 * exist. The shared `undefined_object` classification intentionally combines
 * both cases, so this security boundary must retain the narrower driver signal.
 */
function normalizeMissingTableName(value: string): string {
  const unquoted = value.replace(/["'`[\]]/g, '');
  return (unquoted.split('.').at(-1) ?? unquoted)
    .replace(/[^A-Za-z0-9_$-]/g, '')
    .toLowerCase();
}

function missingTableNames(messages: readonly string[]): string[] {
  const names: string[] = [];
  const patterns = [
    /no such table:\s*([^\s,;]+)/giu,
    /(?:relation|table)\s+((?:"[^"]+"(?:\."[^"]+")*)|(?:[A-Za-z0-9_.$-]+))\s+does not exist/giu,
    /table with name\s+((?:"[^"]+")|(?:[A-Za-z0-9_.$-]+))\s+does not exist/giu,
  ];
  for (const message of messages) {
    for (const pattern of patterns) {
      for (const match of message.matchAll(pattern)) {
        if (match[1]) names.push(normalizeMissingTableName(match[1]));
      }
    }
  }
  return names;
}

function isMissingTableError(error: unknown, expectedTable: string): boolean {
  const classification = classifyDatabaseError(error);
  if (classification.kind !== 'undefined_object') return false;
  if (
    classification.sqlstate === '42703' ||
    classification.driverCode === '42703' ||
    classification.driverCodes.includes('42703')
  ) {
    return false;
  }
  const names = missingTableNames(classification.driverMessages);
  const expected = normalizeMissingTableName(expectedTable);
  return (
    names.length > 0 &&
    names.every((missingTableName) => missingTableName === expected)
  );
}

async function tolerateMissingSystemTable<T>(
  operation: () => Promise<T>,
  fallback: T,
  context: { table: string; action: string },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isMissingTableError(error, context.table)) throw error;
    logger.warn(
      `Cascade delete skipped ${context.action} on '${context.table}': ` +
        'table not found in this database.',
      { error: error instanceof Error ? error.message : String(error) },
    );
    return fallback;
  }
}

/**
 * The ids of the rows of `tableName` whose `column` references one of `ids`,
 * minus `exclude` (the caller's own targets).
 */
async function selectChildren(
  db: DatabaseInterface,
  tableName: string,
  column: string,
  ids: string[],
  exclude: TargetExclusion,
): Promise<string[]> {
  const found: string[] = [];
  for (const batch of chunkArray(ids, IN_LIST_CHUNK_SIZE)) {
    const dialect = usesPostgresDialect(db) ? 'postgres' : 'sqlite';
    const where = withRawPredicate(
      buildWhere(
        { ...idPredicate(column, batch), ...exclude.filter },
        1,
        dialect,
      ),
      exclude.raw,
      1,
    );
    const table = `"${tableName.replaceAll('"', '""')}"`;
    const sql = `SELECT CAST("id" AS VARCHAR) AS "id" FROM ${table} ${where.sql}`;
    const rows = await tolerateMissingTable(
      () => db.query(sql, ...where.values).then((result) => result.rows),
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

/**
 * The classes sharing one STI table, indexed by every spelling a stored
 * discriminator may use (qualified name, simple name, previous qualified
 * names), compared case-insensitively *within the hierarchy only*. A spelling
 * two different member classes share is ambiguous. Never resolved through the
 * registry's global, case-insensitive lookup, which can pick a class from
 * another table.
 */
interface StiHierarchy {
  bySpelling: Map<string, Set<string>>;
}

function stiHierarchyFor(ctx: CascadeContext, className: string): StiHierarchy {
  const base = ctx.registry.getSTIBase(className) ?? className;
  const cached = ctx.stiHierarchies.get(base);
  if (cached) return cached;
  const bySpelling = new Map<string, Set<string>>();
  for (const name of [base, ...ctx.registry.getDescendants(base), className]) {
    const registered = ctx.registry.getClass(name);
    const member = registered?.qualifiedName ?? name;
    const spellings = [
      name,
      registered?.qualifiedName,
      registered?.name,
      ...(registered?.config?.previousQualifiedNames ?? []),
    ];
    for (const spelling of spellings) {
      if (typeof spelling !== 'string' || !spelling) continue;
      const key = spelling.toLowerCase();
      const set = bySpelling.get(key) ?? new Set<string>();
      set.add(member);
      bySpelling.set(key, set);
    }
  }
  const hierarchy = { bySpelling };
  ctx.stiHierarchies.set(base, hierarchy);
  return hierarchy;
}

/**
 * The member classes a stored discriminator can name: one class, several
 * (ambiguous), or none (unknown).
 */
function stiCandidates(hierarchy: StiHierarchy, metaType: string): string[] {
  return [...(hierarchy.bySpelling.get(metaType.toLowerCase()) ?? [])];
}

async function deleteByIds(
  db: DatabaseInterface,
  identity: SyncRowIdentity,
  ids: string[],
): Promise<DeletedRowOwners> {
  const { tableName } = identity;
  const removed: DeletedRowOwners = [];
  for (const batch of chunkArray(ids, IN_LIST_CHUNK_SIZE)) {
    const result = await tolerateMissingTable(
      () =>
        deleteSyncRows(db, identity, idPredicate('id', batch), (affected) =>
          recordCascadeWrite(db, { affected }),
        ),
      undefined,
      { table: tableName, action: 'CASCADE delete' },
    );
    if (result?.owners) removed.push(...result.owners);
  }
  return removed;
}

/**
 * Remove the framework-managed side rows owned by the given object ids.
 *
 * `_smrt_contexts` and `_smrt_embeddings` are keyed by `(owner_class, owner_id)`
 * and `(object_class, object_id)` respectively. Matched by id *and* class
 * (review fix): id alone would let two unrelated classes using
 * `idType: 'text'` (non-UUID, not guaranteed globally unique) collide on a
 * shared id value and delete each other's memory/embeddings rows. `classNames`
 * is the STI-hierarchy-expanded candidate set from
 * {@link ownerClassCandidates} — the class column stores the *runtime*
 * constructor name, which for an STI hierarchy is a concrete subclass rather
 * than the class the cascade was planned from, so a single exact name is not
 * enough.
 *
 * A missing system table is not an error — an application database may predate
 * the table. Every other cleanup failure propagates so the surrounding delete
 * transaction rolls back rather than orphaning tenant-sensitive recall data.
 */
async function deleteSystemRows(
  db: DatabaseInterface,
  ids: string[],
  classNames: string[],
): Promise<void> {
  const ownerIds = ids.filter(
    (id) =>
      typeof id === 'string' &&
      id.length > 0 &&
      id !== COLLECTION_OWNER_SENTINEL,
  );
  if (ownerIds.length === 0 || classNames.length === 0) return;

  for (const [table, idColumn, classColumn] of [
    [CONTEXTS_TABLE, 'owner_id', 'owner_class'],
    [EMBEDDINGS_TABLE, 'object_id', 'object_class'],
  ] as const) {
    for (const batch of chunkArray(ownerIds, IN_LIST_CHUNK_SIZE)) {
      await tolerateMissingSystemTable(
        () =>
          db
            .delete(table, {
              ...idPredicate(idColumn, batch),
              ...idPredicate(classColumn, classNames),
            })
            .then((result) => recordCascadeWrite(db, result)),
        undefined,
        { table, action: 'framework-owned row cleanup' },
      );
    }
  }
}

/** Tables already warned about a skipped row lock (once per process). */
const unlockedTablesWarned = new Set<string>();

/**
 * Lock `ids` of `tableName` `FOR UPDATE` (PostgreSQL) so no new reference to
 * them can commit while the cascade runs.
 *
 * `FOR UPDATE` is the only row lock that conflicts with the `FOR KEY SHARE`
 * a referencing INSERT or UPDATE takes on its target; every row-locking
 * clause needs `UPDATE` privilege on at least one column, which a cascade
 * never needed before. The privilege is read from the catalog first (a probe
 * that cannot fail); a role without it skips the lock with a warning and
 * keeps the delete it always had (the concurrent-reference window then
 * remains for that role). Ids are sorted before chunking and each chunk is
 * locked `ORDER BY id`, so two cascades over overlapping ids take their row
 * locks in the same order and do not deadlock each other.
 */
async function lockReferencedRows(
  ctx: CascadeContext,
  tableName: string,
  ids: string[],
): Promise<void> {
  let lockable = ctx.lockable.get(tableName);
  if (lockable === undefined) {
    const result = await ctx.db.query(
      `SELECT COALESCE(has_any_column_privilege(to_regclass(format('%I', $1::text)), 'UPDATE'), false) AS lockable`,
      tableName,
    );
    lockable = result.rows[0]?.lockable === true;
    ctx.lockable.set(tableName, lockable);
    if (!lockable && !unlockedTablesWarned.has(tableName)) {
      // Once per table per process: the condition is a standing grant.
      unlockedTablesWarned.add(tableName);
      logger.warn(
        `Cascade delete on '${tableName}' did not lock the rows it deletes: ` +
          'the database role has no UPDATE privilege on that table, which ' +
          'SELECT … FOR UPDATE requires. A reference another connection adds ' +
          'while the cascade runs can be removed or nulled by the database ' +
          'without a change-feed entry. Grant UPDATE on one column to close it.',
      );
    }
  }
  if (!lockable) return;
  const table = `"${tableName.replaceAll('"', '""')}"`;
  const sorted = [...ids].sort();
  for (const batch of chunkArray(sorted, IN_LIST_CHUNK_SIZE)) {
    const where = buildWhere(idPredicate('id', batch), 1, 'postgres');
    await ctx.db.query(
      `SELECT 1 FROM ${table} ${where.sql} ORDER BY "id" FOR UPDATE`,
      ...where.values,
    );
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

  // PostgreSQL READ COMMITTED: another connection could insert a referencing
  // row after the scans below and before this level's rows are deleted; the
  // database's own ON DELETE action would then remove or null it without the
  // cascade seeing it, and the feed would miss it. Locking these rows FOR
  // UPDATE first blocks new references to them (a referencing insert takes
  // FOR KEY SHARE on its target) until the cascade's transaction ends.
  if (plan.references.length > 0 && usesPostgresDialect(ctx.db)) {
    await lockReferencedRows(ctx, tableName, pending);
  }

  // SQL NO ACTION is immediate on every supported SMRT migration path, so the
  // app-side belt preflights it exactly like RESTRICT before any mutation.
  for (const reference of plan.references) {
    if (reference.action !== 'RESTRICT' && reference.action !== 'NO ACTION') {
      continue;
    }
    let remaining = 0;
    for (const batch of chunkArray(pending, IN_LIST_CHUNK_SIZE)) {
      remaining += await tolerateMissingTable(
        () =>
          ctx.db.count(
            reference.tableName,
            idPredicate(reference.column, batch),
          ),
        0,
        { table: reference.tableName, action: `${reference.action} check` },
      );
      if (remaining > 0) break;
    }
    if (remaining > 0) {
      throw DatabaseError.constraintViolation(
        `${reference.className}.${reference.fieldName} ` +
          `${reference.declared ? 'declares' : 'resolves to'} onDelete: ` +
          `'${reference.action}' and ${remaining} row(s) still reference this ` +
          `${className}`,
        reference.column,
      );
    }
  }

  for (const reference of plan.references) {
    if (reference.action === 'SET NULL') {
      const projection = await feedProjectionFor(
        ctx,
        reference.className,
        reference.tableName,
        ctx.registry.getTableStrategy(reference.className) === 'sti',
      );
      // A self-referencing SET NULL leaves the caller's own target rows
      // alone: clearing a target's owner column first would leave its own
      // DELETE nothing to attribute its tombstone to.
      const exclusion = await excludeTargets(ctx, reference.tableName);
      for (const batch of chunkArray(pending, IN_LIST_CHUNK_SIZE)) {
        const result = await tolerateMissingTable(
          () =>
            nullSyncReference(
              ctx.db,
              reference.tableName,
              reference.column,
              {
                ...idPredicate(reference.column, batch),
                ...exclusion.filter,
              },
              (affected) => recordCascadeWrite(ctx.db, { affected }),
              // Only columns proven present and readable; without a readable
              // `id` the statement is exactly the one issued before #5444.
              {
                id: projection.idReadable,
                ownerColumns: projection.ownerColumns,
                metaType: projection.metaTypeReadable,
              },
              exclusion.raw,
            ),
          undefined,
          { table: reference.tableName, action: 'SET NULL' },
        );
        if (!projection.idReadable && (result?.affected ?? 0) > 0) {
          ctx.unrecorded.add(reference.tableName);
        }
        queueFeedRows(
          ctx,
          reference.tableName,
          'update',
          projection,
          result?.rows,
          reference.column,
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

    // The rows the caller deletes itself (a self-reference) stay with the
    // caller: removing them here would leave its own DELETE nothing to
    // remove and record them twice. The engine compares the ids.
    const childIds = await selectChildren(
      ctx.db,
      reference.tableName,
      reference.column,
      pending,
      await excludeTargets(ctx, reference.tableName),
    );
    if (childIds.length === 0) continue;

    await resolveReferences(
      ctx,
      reference.className,
      reference.tableName,
      childIds,
      depth + 1,
    );
    await deleteSystemRows(
      ctx.db,
      childIds,
      ownerClassCandidates(ctx.registry, reference.className),
    );
    const sti = ctx.registry.getTableStrategy(reference.className) === 'sti';
    const projection = await feedProjectionFor(
      ctx,
      reference.className,
      reference.tableName,
      sti,
    );
    const removed = await deleteByIds(
      ctx.db,
      {
        tableName: reference.tableName,
        model: toQualifiedClassName(ctx.registry, reference.className),
        tenantColumn: ctx.registry.getOwnershipTenantColumn(
          reference.className,
        ),
        sti,
        ownerColumns: projection.ownerColumns,
        returnRows: true,
      },
      childIds,
    );
    queueFeedRows(ctx, reference.tableName, 'delete', projection, removed);
    ctx.affectedTables.add(reference.tableName);
    ctx.affectedTableClasses.set(
      reference.tableName,
      toQualifiedClassName(ctx.registry, reference.className),
    );
  }

  for (const association of plan.polymorphic) {
    // A caught missing-table DELETE still aborts PostgreSQL's transaction.
    // Optional/abstract association tables must be checked before mutation.
    if (!(await ctx.db.tableExists(association.tableName))) continue;
    const associationSti =
      ctx.registry.getTableStrategy(association.className) === 'sti';
    const projection = await feedProjectionFor(
      ctx,
      association.className,
      association.tableName,
      associationSti,
    );
    // An association row that points at itself and is the caller's own
    // target stays with the caller's DELETE (recorded once, under its stored
    // owner).
    const exclusion = await excludeTargets(ctx, association.tableName);
    for (const batch of chunkArray(pending, IN_LIST_CHUNK_SIZE)) {
      const where: Record<string, unknown> = {
        ...idPredicate('meta_id', batch),
        ...exclusion.filter,
      };
      if (plan.metaTypes.length === 1) {
        where.meta_type = plan.metaTypes[0];
      } else {
        where['meta_type in'] = plan.metaTypes;
      }
      const result = await tolerateMissingTable(
        () =>
          deleteSyncRows(
            ctx.db,
            {
              tableName: association.tableName,
              model: toQualifiedClassName(ctx.registry, association.className),
              tenantColumn: ctx.registry.getOwnershipTenantColumn(
                association.className,
              ),
              sti: associationSti,
              ownerColumns: projection.ownerColumns,
              returnRows: true,
            },
            where,
            (affected) => recordCascadeWrite(ctx.db, { affected }),
            undefined,
            exclusion.raw,
          ),
        undefined,
        {
          table: association.tableName,
          action: 'polymorphic association cleanup',
        },
      );
      queueFeedRows(
        ctx,
        association.tableName,
        'delete',
        projection,
        result?.owners,
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
  /**
   * Target ids (as the engine returned them) whose stored ownership columns
   * changed while the cascade ran — a database `ON DELETE` action reaching
   * back to the target. The owner the caller's own DELETE returns for them
   * is not the owner they had, so their tombstone must not be attributed
   * from it.
   */
  disturbedTargets?: string[];
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
    feed: new Map(),
    classOwners: new Map(),
    projections: new Map(),
    target: { tableName: target.tableName, ids: [...target.ids] },
    unrecorded: new Set(),
    lockable: new Map(),
    stiHierarchies: new Map(),
  };
  // The targets' own owner columns before any cascade statement: a database
  // ON DELETE action (a physical FK cycle back to a target) can rewrite them
  // before the caller's DELETE returns them.
  const ownersBefore = await readTargetOwners(ctx, target);
  await resolveReferences(
    ctx,
    target.className,
    target.tableName,
    target.ids,
    0,
  );
  await deleteSystemRows(
    db,
    target.ids,
    ownerClassCandidates(registry, target.className),
  );
  const ownersAfter = ownersBefore
    ? await readTargetOwners(ctx, target)
    : undefined;
  const disturbedTargets: string[] = [];
  for (const [id, before] of ownersBefore ?? []) {
    const after = ownersAfter?.get(id);
    if (!after) continue;
    if (
      Object.keys(before).some((column) => before[column] !== after[column])
    ) {
      disturbedTargets.push(id);
    }
  }
  // Every level ran without a refusal, so the cascade's rows are final for
  // this transaction. Appended on its handle, the entries commit or roll back
  // with it; a failed append is warned and never fails the delete.
  await recordCascadeChanges(db, [...ctx.feed.values()], ctx.unrecorded);
  return {
    affectedTables: ctx.affectedTables,
    affectedTableClasses: ctx.affectedTableClasses,
    disturbedTargets,
  };
}

/**
 * The caller's target rows' stored ownership columns (as text), by id as the
 * engine returns it, or `undefined` when the target class has none the role
 * can read (nothing to verify).
 */
async function readTargetOwners(
  ctx: CascadeContext,
  target: { className: string; tableName: string; ids: string[] },
): Promise<Map<string, Record<string, unknown>> | undefined> {
  if (target.ids.length === 0) return undefined;
  const projection = await feedProjectionFor(
    ctx,
    target.className,
    target.tableName,
    ctx.registry.getTableStrategy(target.className) === 'sti',
  );
  const columns = projection.ownerColumns;
  if (columns.length === 0) return undefined;
  const owners = new Map<string, Record<string, unknown>>();
  for (const batch of chunkArray(target.ids, IN_LIST_CHUNK_SIZE)) {
    if (isJsonAdapterHandle(ctx.db)) {
      for (const row of await ctx.db.list(
        target.tableName,
        idPredicate('id', batch),
      )) {
        owners.set(
          String(row.id),
          Object.fromEntries(columns.map((column) => [column, row[column]])),
        );
      }
      continue;
    }
    const dialect = usesPostgresDialect(ctx.db) ? 'postgres' : 'sqlite';
    const where = buildWhere(idPredicate('id', batch), 1, dialect);
    const table = `"${target.tableName.replaceAll('"', '""')}"`;
    const select = columns
      .map(
        (column, index) =>
          `CAST("${column.replaceAll('"', '""')}" AS VARCHAR) AS "_smrt_owner_${index}"`,
      )
      .join(', ');
    const result = await ctx.db.query(
      `SELECT CAST("id" AS VARCHAR) AS "id", ${select} FROM ${table} ${where.sql}`,
      ...where.values,
    );
    for (const row of result.rows) {
      owners.set(
        String(row.id),
        Object.fromEntries(
          columns.map((column, index) => [
            column,
            row[`_smrt_owner_${index}`] ?? null,
          ]),
        ),
      );
    }
  }
  return owners;
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
 * When the adapter exposes `transaction()`, the whole sequence runs inside one
 * — including framework-owned row cleanup and the caller's `deleteSelf`
 * statement, so a failure part-way through cannot leave either side orphaned.
 * Adapters without transaction support run the same statements sequentially;
 * this is the documented degradation, not a silent one.
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
  deleteSelf: (db: DatabaseInterface, cascade?: CascadeResult) => Promise<void>,
  shouldCascade?: (db: DatabaseInterface) => Promise<boolean>,
): Promise<CascadeResult> {
  const ids = target.id ? [target.id] : [];

  // Nothing references this class AND no polymorphic association class is
  // registered anywhere in the process. `plan.polymorphic` is unconditionally
  // every registered `SmrtPolymorphicAssociation` subclass — a `metaType`
  // column can point at any class at runtime, so there is no static metadata
  // to scope it by, unlike a typed `@foreignKey`/`@crossPackageRef`. This
  // branch is therefore common for a class with no incoming references in an
  // app with no polymorphic associations at all, but rare — not "the
  // overwhelmingly common case" — once even one polymorphic class exists
  // anywhere in the process, since every delete's plan then carries it.
  // Framework-owned context and embedding rows still need atomic cleanup even
  // when the registry has no typed or polymorphic references for this class.
  if (buildCascadePlan(registry, target.className).isEmpty) {
    const runWithoutReferences = async (
      bound: DatabaseInterface,
    ): Promise<CascadeResult> => {
      if (!shouldCascade || (await shouldCascade(bound))) {
        await deleteSystemRows(
          bound,
          ids,
          ownerClassCandidates(registry, target.className),
        );
      }
      await deleteSelf(bound);
      return { affectedTables: new Set(), affectedTableClasses: new Map() };
    };
    const transaction = (db as TransactionCapable).transaction;
    if (typeof transaction !== 'function') return runWithoutReferences(db);
    return runInOwningCascadeTransaction(db, runWithoutReferences);
  }

  const run = async (bound: DatabaseInterface): Promise<CascadeResult> => {
    const result =
      !shouldCascade || (await shouldCascade(bound))
        ? await cascadeReferencesTo(bound, registry, {
            className: target.className,
            tableName: target.tableName,
            ids,
          })
        : {
            affectedTables: new Set<string>(),
            affectedTableClasses: new Map<string, string>(),
          };
    // The cascade's result goes to the caller's DELETE so a target whose
    // owner a database action rewrote is not attributed from its new value.
    await deleteSelf(bound, result);
    return result;
  };

  const transaction = (db as TransactionCapable).transaction;
  if (typeof transaction !== 'function') {
    return run(db);
  }

  return runInOwningCascadeTransaction(db, run);
}

/**
 * Message of the statement that aborts a caller-owned native DuckDB
 * transaction after a cascade failed part-way through it (#2824).
 */
export const CASCADE_ABORTED_CALLER_TRANSACTION =
  'smrt: delete cascade failed inside a caller-owned DuckDB transaction; the transaction is aborted';

/**
 * Own the cascade's atomic scope (#2824).
 *
 * The cascade and the target's own `DELETE` run in a transaction opened on
 * `db`. When `db` is already a transaction handle on an engine without
 * `SAVEPOINT`, the SDK refuses the nested `transaction()` before running the
 * callback or touching the enclosing transaction (`NestedTransactionError`).
 * The cascade then joins that enclosing transaction directly instead of
 * failing, which is the only atomic scope there is:
 *
 * - framework-owned handles (`withTransaction()`, the bulk junction path) —
 *   unchanged since #2818;
 * - caller-owned native DuckDB transactions (`db.transaction(tx => …)` or
 *   `beginTransaction()` handed to `withDatabase()`). Commit and rollback stay
 *   the caller's: a rollback discards the cascade with everything else.
 *
 * Joining without a savepoint means a cascade that fails after issuing some
 * of its writes cannot be undone on its own. On native DuckDB the framework
 * therefore aborts the joined transaction before rethrowing when the cascade
 * already issued a write (a refusal before the first write, such as the
 * depth-0 RESTRICT / NO ACTION preflight, leaves it untouched). DuckDB's
 * `delete()` reports a constant affected count and owned-row cleanup always
 * runs, so in practice any failure after that preflight aborts — DuckDB then
 * refuses every later statement in it and its `COMMIT` persists nothing — so a
 * caller that swallows the error can never commit a half-applied cascade. The
 * callback runs at most once: the nested refusal happens before it starts, and
 * nothing is replayed after it has.
 *
 * Other no-savepoint adapters (the JSON adapter) keep the detectable
 * `NestedTransactionError` refusal for caller-owned transactions by default:
 * they offer no statement that poisons the enclosing transaction, so joining
 * could commit a partial cascade. The compatible bulk junction path (#2818)
 * passes `reuseUnsupportedNested: true` to keep its established join-any
 * behavior, and still gets the DuckDB abort-on-failure guard.
 *
 * @param db - Database the cascade is bound to (a root or a transaction handle)
 * @param run - Cascade plus the target's own delete, on the transaction-bound db
 * @param reuseUnsupportedNested - Join any enclosing transaction that refuses
 *   nesting; defaults to framework-owned handles and native DuckDB
 */
export async function runInOwningCascadeTransaction<T>(
  db: DatabaseInterface,
  run: (bound: DatabaseInterface) => Promise<T>,
  reuseUnsupportedNested?: boolean,
): Promise<T> {
  const nativeDuckDb = isKnownNativeDuckDbHandle(db);
  return withEmbeddedWriteTransaction(
    db,
    isEmbeddedDatabase(db),
    async (bound) => {
      // `bound === db` only when the nested transaction was refused and the
      // cascade joined the enclosing one; an opened transaction is a new scope.
      if (bound !== db || !nativeDuckDb) return run(bound);
      const writesBefore = cascadeWrites.get(bound) ?? 0;
      try {
        return await run(bound);
      } catch (error) {
        // Only a cascade that already changed rows is half-applied; a refusal
        // before its first write (RESTRICT / NO ACTION) leaves the caller's
        // transaction intact and usable.
        if ((cascadeWrites.get(bound) ?? 0) > writesBefore) {
          await abortJoinedDuckDbTransaction(bound);
        }
        throw error;
      }
    },
    reuseUnsupportedNested ??
      (isFrameworkTransactionHandle(db) || nativeDuckDb),
  );
}

/**
 * Put a joined native DuckDB transaction into DuckDB's aborted state.
 *
 * A failing statement is the engine's own mechanism: after it, DuckDB rejects
 * every statement with "Current transaction is aborted" until the transaction
 * ends, and ending it discards its writes. The statement is expected to throw,
 * and its error is not the one the caller needs, so it is dropped when the
 * engine reported it. A rejection that did not come from the engine (an
 * adapter that stopped forwarding queries) proves nothing about the
 * transaction, so the statement is repeated on the handle's own connection;
 * when neither attempt is confirmed by the engine this throws, so the caller
 * never believes a transaction that may still commit has been poisoned.
 */
export async function abortJoinedDuckDbTransaction(
  db: DatabaseInterface,
  message = CASCADE_ABORTED_CALLER_TRANSACTION,
): Promise<void> {
  const statement = `SELECT error('${message.replaceAll("'", "''")}')`;
  const confirmed = (error: unknown): boolean => {
    const text = error instanceof Error ? error.message : String(error);
    return text.includes(message) || /transaction is aborted/i.test(text);
  };
  let unconfirmed: unknown;
  try {
    await db.query(statement);
    unconfirmed = new Error('the abort statement did not fail');
  } catch (error) {
    if (confirmed(error)) return;
    unconfirmed = error;
  }
  const client = (
    db as { client?: { run?: (sql: string) => Promise<unknown> } }
  ).client;
  if (typeof client?.run === 'function') {
    try {
      await client.run(statement);
    } catch (error) {
      if (confirmed(error)) return;
    }
  }
  throw new Error(
    'Could not confirm that the joined DuckDB transaction was aborted; it must not be committed',
    { cause: unconfirmed },
  );
}
