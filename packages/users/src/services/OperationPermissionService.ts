/**
 * Reusable operation-level permission guard for hand-written server surfaces.
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  deriveOperationPermissionSlug,
  type OperationPermissionCollectionInput,
  type PermissionCatalog,
  PermissionCatalogService,
} from './PermissionCatalogService.js';
import {
  type PermissionResolutionOptions,
  PermissionResolver,
} from './PermissionResolver.js';
import { getCurrentSessionPermissionContext } from './SessionPermissionContext.js';

export type OperationPermissionDenyReason =
  | 'invalid_operation'
  | 'missing_principal'
  | 'resolution_error'
  | 'unknown_permission'
  | 'permission_denied';

export type OperationPermissionAllowReason =
  | 'permission_granted'
  | 'super_admin_bypass'
  | 'system_context_bypass';

export interface OperationPermissionDecision {
  allowed: boolean;
  permission: string | null;
  reason: OperationPermissionAllowReason | OperationPermissionDenyReason;
  error?: unknown;
}

export interface OperationPermissionOptions
  extends SmrtClassOptions,
    PermissionResolutionOptions {
  /**
   * Collection slug, model class, model instance, or collection instance.
   */
  collection: OperationPermissionCollectionInput;
  /**
   * Operation action. `list` and `get` normalize to the catalog's `.read`.
   */
  action: string;
  /**
   * Default true. When false, a super-admin tenant context must still hold the
   * resolved permission.
   */
  allowSuperAdminBypass?: boolean;
  /**
   * Default true. System context represents trusted server-side execution.
   */
  allowSystemContextBypass?: boolean;
  catalog?: PermissionCatalog;
  onDeny?: 'return' | 'throw';
  resolver?: PermissionResolver;
  tenantId?: string | null;
  userId?: string | null;
  /**
   * When provided, authorize against THIS exact permission set instead of
   * re-resolving live RBAC. Pass the published principal set
   * (`context.permissionSet`) so an RLS-off catalog gate enforces the same
   * snapshot authority the RLS-on session published — keeping the authority
   * bound adapter-independent. Without it a mid-run role grant, or a reduced
   * pre-resolved `permissions` set, could let SQLite/dev allow an operation the
   * Postgres RLS path for the same principal context would deny.
   */
  permissionSet?: ReadonlySet<string> | readonly string[];
}

export class OperationPermissionError extends Error {
  readonly decision: OperationPermissionDecision;
  readonly permission: string | null;
  readonly status = 403;

  constructor(decision: OperationPermissionDecision) {
    super(
      decision.permission
        ? `Permission denied for '${decision.permission}'.`
        : 'Permission denied.',
    );
    this.name = 'OperationPermissionError';
    this.decision = decision;
    this.permission = decision.permission;
  }
}

interface RuntimeBypassContext {
  superAdminBypass: boolean;
  systemContext: boolean;
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find package '@happyvertical\/smrt-tenancy'/.test(error.message))
  );
}

async function readTenancyBypassContext(): Promise<RuntimeBypassContext> {
  try {
    const tenancy = await import('@happyvertical/smrt-tenancy');
    return {
      superAdminBypass: tenancy.isSuperAdminBypass(),
      systemContext: tenancy.isSystemContext(),
    };
  } catch (error) {
    if (!isModuleNotFoundError(error)) {
      throw error;
    }

    return {
      superAdminBypass: false,
      systemContext: false,
    };
  }
}

function deny(
  permission: string | null,
  reason: OperationPermissionDenyReason,
  error?: unknown,
): OperationPermissionDecision {
  return {
    allowed: false,
    error,
    permission,
    reason,
  };
}

function allow(
  permission: string,
  reason: OperationPermissionAllowReason,
): OperationPermissionDecision {
  return {
    allowed: true,
    permission,
    reason,
  };
}

function hasCatalogSlug(
  catalog: PermissionCatalog,
  permission: string,
): boolean {
  return catalog.permissions.some(
    (definition) => definition.slug === permission,
  );
}

export async function checkOperationPermission(
  options: OperationPermissionOptions,
): Promise<OperationPermissionDecision> {
  let permission: string;
  try {
    permission = deriveOperationPermissionSlug(
      options.collection,
      options.action,
    );
  } catch (error) {
    return deny(null, 'invalid_operation', error);
  }

  const catalog =
    options.catalog ?? PermissionCatalogService.create(options).getCatalog();
  if (!hasCatalogSlug(catalog, permission)) {
    return deny(permission, 'unknown_permission');
  }

  const sessionContext = getCurrentSessionPermissionContext();
  let tenancyContext: RuntimeBypassContext;
  try {
    tenancyContext = await readTenancyBypassContext();
  } catch (error) {
    return deny(permission, 'resolution_error', error);
  }
  const systemContext =
    sessionContext?.systemContext === true || tenancyContext.systemContext;
  const superAdminBypass =
    sessionContext?.superAdminBypass === true ||
    tenancyContext.superAdminBypass;

  if (systemContext && options.allowSystemContextBypass !== false) {
    return allow(permission, 'system_context_bypass');
  }

  if (superAdminBypass && options.allowSuperAdminBypass !== false) {
    return allow(permission, 'super_admin_bypass');
  }

  const userId = options.userId ?? sessionContext?.userId ?? null;
  const tenantId = options.tenantId ?? sessionContext?.tenantId ?? null;
  if (!userId || !tenantId) {
    return deny(permission, 'missing_principal');
  }

  // Explicit set wins over a live re-resolve: authorize against the exact
  // published principal set so the gate matches what an RLS session enforces
  // for the same context (adapter-independent, snapshot-consistent).
  if (options.permissionSet !== undefined) {
    const granted = Array.isArray(options.permissionSet)
      ? options.permissionSet.includes(permission)
      : (options.permissionSet as ReadonlySet<string>).has(permission);
    return granted
      ? allow(permission, 'permission_granted')
      : deny(permission, 'permission_denied');
  }

  try {
    const resolver =
      options.resolver ?? (await PermissionResolver.create(options));
    const hasPermission = await resolver.hasPermission(
      userId,
      tenantId,
      permission,
      { membership: options.membership },
    );
    return hasPermission
      ? allow(permission, 'permission_granted')
      : deny(permission, 'permission_denied');
  } catch (error) {
    return deny(permission, 'resolution_error', error);
  }
}

export async function hasOperationPermission(
  options: OperationPermissionOptions,
): Promise<boolean> {
  return (await checkOperationPermission(options)).allowed;
}

export async function assertOperationPermission(
  options: OperationPermissionOptions,
): Promise<OperationPermissionDecision> {
  const decision = await checkOperationPermission(options);
  if (decision.allowed || options.onDeny === 'return') {
    return decision;
  }

  throw new OperationPermissionError(decision);
}
