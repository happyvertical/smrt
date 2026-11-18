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

/**
 * Returns the instance property names that hold the tenant of rows written by
 * `ctor`'s class, `[]` when the class has no tenant column, or `undefined`
 * when the class is unknown to the registry.
 */
export type ChangeFeedTenantFieldResolver = (
  ctor: unknown,
) => readonly string[] | undefined;

let tenantFieldResolver: ChangeFeedTenantFieldResolver | undefined;

/** Register the registry's tenant-field lookup (dependency inversion). */
export function setChangeFeedTenantFieldResolver(
  resolver: ChangeFeedTenantFieldResolver | undefined,
): void {
  tenantFieldResolver = resolver;
}

/** The property read when the registry names no tenant field. */
const DEFAULT_TENANT_FIELD = 'tenantId';

/**
 * The tenant a change to `instance` is recorded under: the value of the
 * class's ownership field as the registry resolves it (falling back to the
 * `tenantId` property for a class the registry does not know or that has no
 * tenant column), `null` for a global row, or `undefined` when two ownership
 * fields hold different tenants — an ambiguity the caller must not record as
 * either tenant, let alone as global.
 */
export function resolveChangeFeedTenantId(
  instance: object,
): string | null | undefined {
  let fields: readonly string[] | undefined;
  try {
    fields = tenantFieldResolver?.(instance.constructor);
  } catch {
    fields = undefined;
  }
  const candidates =
    fields && fields.length > 0 ? fields : [DEFAULT_TENANT_FIELD];
  const record = instance as Record<string, unknown>;
  let tenantId: string | null = null;
  for (const field of candidates) {
    const value = record[field];
    if (typeof value !== 'string' || !value) continue;
    if (tenantId !== null && tenantId !== value) return undefined;
    tenantId = value;
  }
  return tenantId;
}
