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
    if (typeof value !== 'string' || !value) continue;
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
 * The same answer as {@link resolveChangeFeedTenantId}, read from a stored
 * row (keyed by column) instead of the in-memory instance.
 */
export function resolveChangeFeedTenantIdFromRow(
  fields: readonly ChangeFeedTenantField[],
  row: Record<string, unknown>,
): string | null | undefined {
  return agreeingTenant(fields, ({ column }) => row[column]);
}
