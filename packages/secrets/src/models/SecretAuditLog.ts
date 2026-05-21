/**
 * SecretAuditLog model - Audit trail for secret operations
 * @packageDocumentation
 */

import type { SmrtCreateInput } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Secret audit action types
 */
export type SecretAuditAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'rotate_key'
  | 'disable'
  | 'enable'
  | 'expire';

/**
 * Audit result types
 */
export type SecretAuditResult = 'success' | 'failure' | 'denied';

/**
 * SecretAuditLog records all operations on secrets for compliance
 * and security monitoring.
 *
 * Every secret operation (create, read, update, delete, key rotation)
 * is logged with the user, action, result, and relevant details.
 *
 * **Retention**: Audit logs should be retained according to your
 * compliance requirements (typically 1-7 years).
 *
 * @example
 * ```typescript
 * // Query recent audit logs
 * const logs = await auditLogs.list({
 *   where: { tenantId: 'tenant-123' },
 *   orderBy: 'created_at DESC',
 *   limit: 100
 * });
 *
 * // Filter by action
 * const reads = await auditLogs.list({
 *   where: {
 *     tenantId: 'tenant-123',
 *     action: 'read'
 *   }
 * });
 *
 * // Filter by secret name
 * const apiKeyLogs = await auditLogs.list({
 *   where: {
 *     tenantId: 'tenant-123',
 *     secretName: 'stripe-api-key'
 *   }
 * });
 * ```
 */
// Intentional exception to standards.md §7 (`@TenantScoped({ mode: 'optional' })`):
// `SecretAuditLog` uses the inline `tenantScoped: true` form on `@smrt()` rather than
// the dedicated `@TenantScoped` decorator. Audit-trail queries are read-mostly and run
// in mixed contexts — under a tenant for tenant-scoped reports, and (prospectively)
// under super-admin bypass for compliance review. Cross-tenant audit queries should
// be wrapped in `withSuperAdminBypass()` from `@happyvertical/smrt-tenancy` at the
// call site; this package has no such call sites today, so the pattern is
// prescriptive guidance for compliance tooling rather than current practice. See
// `packages/secrets/CLAUDE.md` "Known exceptions to monorepo standards" for context.
@smrt({
  tenantScoped: true,
  api: { include: [] }, // No API exposure
  mcp: { include: [] }, // No MCP exposure
  cli: { include: ['list'] },
})
export class SecretAuditLog extends SmrtObject {
  /**
   * Tenant associated with the audited secret operation.
   */
  tenantId: string | null = null;

  /**
   * ID of the secret (may be null for deleted secrets)
   */
  secretId: string | null = null;

  /**
   * Name of the secret at the time of the operation
   */
  secretName: string = '';

  /**
   * ID of the user who performed the action
   */
  userId: string = '';

  /**
   * The action that was performed
   */
  action: SecretAuditAction = 'read';

  /**
   * Result of the operation
   */
  result: SecretAuditResult = 'success';

  /**
   * IP address of the client (if available)
   */
  ipAddress: string = '';

  /**
   * User agent string (if available)
   */
  userAgent: string = '';

  /**
   * Additional context about the operation
   */
  details: Record<string, unknown> = {};

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId;
    }
    if (options.secretId !== undefined) this.secretId = options.secretId;
    if (options.secretName !== undefined) this.secretName = options.secretName;
    if (options.userId !== undefined) this.userId = options.userId;
    if (options.action !== undefined) this.action = options.action;
    if (options.result !== undefined) this.result = options.result;
    if (options.ipAddress !== undefined) this.ipAddress = options.ipAddress;
    if (options.userAgent !== undefined) this.userAgent = options.userAgent;
    if (options.details !== undefined) this.details = options.details;
  }

  /**
   * Check if this was a successful operation
   */
  isSuccess(): boolean {
    return this.result === 'success';
  }

  /**
   * Check if this was a failed operation
   */
  isFailure(): boolean {
    return this.result === 'failure';
  }

  /**
   * Check if this was a denied operation (permission denied)
   */
  isDenied(): boolean {
    return this.result === 'denied';
  }

  /**
   * Check if this is a read operation
   */
  isReadAction(): boolean {
    return this.action === 'read';
  }

  /**
   * Check if this is a write operation (create, update, delete)
   */
  isWriteAction(): boolean {
    return ['create', 'update', 'delete'].includes(this.action);
  }

  /**
   * Check if this is a key operation
   */
  isKeyOperation(): boolean {
    return this.action === 'rotate_key';
  }
}

/**
 * Create an audit log entry for a secret operation
 */
export function createAuditEntry(params: {
  secretId?: string | null;
  secretName: string;
  tenantId?: string | null;
  userId: string;
  action: SecretAuditAction;
  result: SecretAuditResult;
  ipAddress?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
}): SmrtCreateInput<SecretAuditLog> {
  const entry: SmrtCreateInput<SecretAuditLog> = {
    secretId: params.secretId ?? null,
    secretName: params.secretName,
    userId: params.userId,
    action: params.action,
    result: params.result,
    ipAddress: params.ipAddress ?? '',
    userAgent: params.userAgent ?? '',
    details: params.details ?? {},
    ...(params.tenantId !== undefined ? { tenantId: params.tenantId } : {}),
  };
  return entry;
}
