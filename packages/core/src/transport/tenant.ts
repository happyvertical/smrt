/**
 * Transport kernel: tenant gate (#5158). Owned by K5; the gate on every
 * operation is switched on here by F5 and nowhere else.
 */
import { notImplemented } from './not-implemented.js';
import type {
  OperationDescriptor,
  Principal,
  TenantScope,
  TransportModel,
} from './types.js';

/**
 * Run `fn` inside the tenant context the caller is entitled to.
 *
 * Contract:
 * - Wraps the collection call and the serialisers; the context ends when `fn`
 *   settles and is never left set for the rest of the request.
 * - A principal with a tenant runs inside that tenant, user and permissions.
 * - An already-active context for a different tenant or user is
 *   `TENANT_CONTEXT_MISMATCH`.
 * - No tenant, read, required-mode model: `TENANT_CONTEXT_REQUIRED`.
 *   Optional-mode model: global rows only, through `scope.readPredicate` on
 *   the model's real tenant column.
 * - No tenant, write: refused.
 * - `allowCrossTenant` runs in the system context.
 * - Tenancy not enabled, or a model that is not tenant-scoped: `fn` runs
 *   directly with a `none` scope.
 * - Reaches tenancy only through the registered entry-point runner; a runner
 *   that does not advertise the kernel's contract version fails closed.
 * - While `model.profile.tenant` is present, establishes context exactly as
 *   that transport does today.
 */
export function runInTenantGate<T>(
  _model: TransportModel,
  _principal: Principal,
  _operation: OperationDescriptor,
  _fn: (scope: TenantScope) => Promise<T>,
): Promise<T> {
  return notImplemented('runInTenantGate', 'K5');
}
