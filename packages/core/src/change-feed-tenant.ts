/**
 * Which tenant a recorded change belongs to.
 *
 * The change feed stores one `tenant_id` per entry, and every tenant-scoped
 * read serves a tenant its own entries **plus** global (`NULL`) ones. So an
 * entry recorded as global is served to every tenant. A tenant-scoped class
 * whose ownership column is not `tenantId` — a tenancy registration such as
 * `{ field: 'organizationId' }`, or a declared custom tenant field — must
 * therefore be read from that field, or its changes reach every tenant.
 *
 * This is a leaf module (it imports nothing) so `change-feed.ts` can consult
 * the registry's answer without importing the registry: `class.ts` already
 * imports `change-feed.ts`, so the reverse edge would be a cycle. The registry
 * installs the resolver at load time, exactly like
 * `setChangeFeedSensitiveClassResolver`.
 */

/** One ownership field: its instance property and its column. */
export interface ChangeFeedTenantField {
  field: string;
  column: string;
  /** Whether the class persists the field, so its column exists. */
  stored: boolean;
}

/**
 * Returns the ownership fields of rows written by `ctor`'s class, `[]` when
 * the class has no tenant column, or `undefined` when the class is unknown to
 * the registry.
 */
export type ChangeFeedTenantFieldResolver = (
  ctor: unknown,
) => readonly ChangeFeedTenantField[] | undefined;

let tenantFieldResolver: ChangeFeedTenantFieldResolver | undefined;

/** Register the registry's tenant-field lookup (dependency inversion). */
export function setChangeFeedTenantFieldResolver(
  resolver: ChangeFeedTenantFieldResolver | undefined,
): void {
  tenantFieldResolver = resolver;
}

/** The field read when the registry names no tenant field. */
const DEFAULT_TENANT_FIELD: ChangeFeedTenantField = {
  field: 'tenantId',
  column: 'tenant_id',
  stored: false,
};

/**
 * The ownership fields of `instance`'s class: the registry's answer, `[]`
 * when the registry names none (the caller falls back to `tenantId`), or
 * `undefined` when the lookup failed.
 */
export function changeFeedTenantFields(
  instance: object,
): readonly ChangeFeedTenantField[] | undefined {
  try {
    return tenantFieldResolver?.(instance.constructor) ?? [];
  } catch {
    // The registry could not say who owns this row. Falling back to the
    // `tenantId` property could record a privately owned row as global, so
    // a failed lookup is unresolved ownership, like an ambiguous one.
    return undefined;
  }
}

/**
 * The single tenant `read` finds across `fields`: `null` when none holds one,
 * `undefined` when two hold different tenants.
 */
function agreeingTenant(
  fields: readonly ChangeFeedTenantField[],
  read: (field: ChangeFeedTenantField) => unknown,
): string | null | undefined {
  const candidates = fields.length > 0 ? fields : [DEFAULT_TENANT_FIELD];
  let tenantId: string | null = null;
  for (const field of candidates) {
    const value = read(field);
    if (value === undefined || value === null || value === '') continue;
    // An owner that is not a string (a native DuckDB UUID read without a
    // cast arrives as a HUGEINT wrapper) cannot be compared or recorded;
    // skipping it would turn an owned row into a global entry.
    if (typeof value !== 'string') return undefined;
    if (tenantId !== null && tenantId !== value) return undefined;
    tenantId = value;
  }
  return tenantId;
}

/**
 * The tenant a change to `instance` is recorded under: the value of the
 * class's ownership field as the registry resolves it (falling back to the
 * `tenantId` property for a class the registry does not know or that has no
 * tenant column), `null` for a global row, or `undefined` when ownership is
 * unresolved — two ownership fields hold different tenants, or the registry
 * lookup failed — which the caller must not record as any tenant, let alone
 * as global.
 */
export function resolveChangeFeedTenantId(
  instance: object,
): string | null | undefined {
  const fields = changeFeedTenantFields(instance);
  if (fields === undefined) return undefined;
  const record = instance as Record<string, unknown>;
  return agreeingTenant(fields, ({ field }) => record[field]);
}

/**
 * One write's view of its class's ownership fields, taken ONCE before the
 * write's statement runs. The columns a statement returns and the fields its
 * returned row is resolved against both come from this snapshot, so a
 * registration that changes while the statement is pending cannot make the
 * second lookup read a column the statement never returned. `fields` is
 * `undefined` when the ownership lookup failed.
 */
export interface ChangeFeedOwnerPlan {
  readonly fields: readonly ChangeFeedTenantField[] | undefined;
}

/** Snapshot `instance`'s ownership fields for one write. */
export function changeFeedOwnerPlan(instance: object): ChangeFeedOwnerPlan {
  return { fields: changeFeedTenantFields(instance) };
}

/**
 * The ownership columns the plan's class persists — the columns a write
 * statement returns so the feed attributes the row it actually wrote or
 * removed — or `undefined` when the ownership lookup failed.
 */
export function changeFeedPlanStoredColumns(
  plan: ChangeFeedOwnerPlan,
): readonly string[] | undefined {
  if (plan.fields === undefined) return undefined;
  return [
    ...new Set(
      plan.fields.filter((field) => field.stored).map(({ column }) => column),
    ),
  ];
}

/**
 * The tenant of a stored row, read from the plan's persisted ownership
 * columns (`row` is keyed by column). The instance's own fields decide only
 * when the class persists no ownership column. `undefined` means ownership
 * is unresolved: the lookup failed, or the row does not carry one of the
 * stored ownership columns (a column the statement did not return, or one
 * missing from the physical table). A missing column is never read as an
 * empty owner, which would record an owned row as global.
 */
export function resolveChangeFeedTenantIdFromStoredRow(
  plan: ChangeFeedOwnerPlan,
  instance: object,
  row: Record<string, unknown>,
): string | null | undefined {
  if (plan.fields === undefined) return undefined;
  const stored = plan.fields.filter((field) => field.stored);
  if (stored.length === 0) {
    const record = instance as Record<string, unknown>;
    return agreeingTenant(plan.fields, ({ field }) => record[field]);
  }
  for (const { column } of stored) {
    if (!Object.hasOwn(row, column) || row[column] === undefined) {
      return undefined;
    }
  }
  return agreeingTenant(stored, ({ column }) => row[column]);
}

/**
 * The tenant of the row a save writes: each ownership column's value in the
 * persisted `data` (keyed by column, after `transformJSON()` and the
 * framework's own column rules).
 *
 * A stored ownership column the write does not carry is decided by the
 * database, not the instance: an update or an upsert onto an existing row
 * keeps its stored value, and an insert takes the column's default. The
 * instance field need not match either, so the owner is unresolved and
 * nothing is recorded, for every kind of save. This holds for every stored
 * ownership column, declared or runtime-registered: `prepareSave()` supplies
 * NULL for an unset declared tenant column only when the conflict target
 * includes it, so a declared column the serialized row drops (for example
 * under `conflictColumns: ['id']`) is omitted like any other.
 */
export function resolveChangeFeedTenantIdFromWrite(
  plan: ChangeFeedOwnerPlan,
  instance: object,
  data: Record<string, unknown>,
): string | null | undefined {
  if (plan.fields === undefined) return undefined;
  const carries = (column: string) =>
    Object.hasOwn(data, column) && data[column] !== undefined;
  if (plan.fields.some(({ stored, column }) => stored && !carries(column))) {
    return undefined;
  }
  const record = instance as Record<string, unknown>;
  return agreeingTenant(plan.fields, ({ field, column }) =>
    carries(column) ? data[column] : record[field],
  );
}

/** The owner a write recorded for the feed (`undefined` = unresolved). */
export interface ChangeFeedWriteOwner {
  tenantId: string | null | undefined;
  /**
   * The id the write's statement bound, captured with the owner, so a hook
   * that reassigns the instance's `id` afterwards cannot pair this owner
   * with another row's id. Absent when the write did not capture one.
   */
  rowId?: string | null;
}

/**
 * Owner evidence per write, keyed by the write's interceptor context object.
 * The write path records the owner of the row it persisted or removed (taken
 * from the statement itself where it can), and the feed writer reads it after
 * the write. Keyed by the context's identity rather than stored in
 * `context.metadata`, so an interceptor that replaces the metadata object
 * cannot drop it and send the entry back to the mutable instance.
 */
const writeOwners = new WeakMap<object, ChangeFeedWriteOwner>();

/** Record the owner of the row the write behind `context` touched. */
export function noteChangeFeedWriteOwner(
  context: object,
  tenantId: string | null | undefined,
  rowId?: unknown,
): void {
  writeOwners.set(
    context,
    rowId === undefined
      ? { tenantId }
      : { tenantId, rowId: typeof rowId === 'string' && rowId ? rowId : null },
  );
}

/**
 * Point the owner recorded for `context`'s write at the row its statement
 * actually wrote, when the write path resolved that row only after the owner
 * was recorded (a natural-key save that adopts a stored row's id). The owner
 * is kept; only the row id changes.
 */
export function rebindChangeFeedWriteRowId(
  context: object,
  rowId: unknown,
): void {
  const owner = writeOwners.get(context);
  if (!owner) return;
  noteChangeFeedWriteOwner(context, owner.tenantId, rowId);
}

/** The owner recorded for `context`'s write, if the write recorded one. */
export function changeFeedWriteOwner(
  context: object | undefined,
): ChangeFeedWriteOwner | undefined {
  return context ? writeOwners.get(context) : undefined;
}
