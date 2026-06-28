/**
 * SecretAuditLogCollection - Collection manager for SecretAuditLog objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  type SecretAuditAction,
  SecretAuditLog,
  type SecretAuditResult,
} from '../models/SecretAuditLog.js';

/**
 * Options for listing audit logs
 */
export interface ListAuditLogsOptions {
  /**
   * Scope results to a single tenant's audit trail. Tenant-facing callers
   * (e.g. SecretService.getAuditLogs) must always set this — audit rows
   * reference secret names and must not leak across tenants (issue #1501).
   * Omit only for cross-tenant compliance tooling running under
   * withSuperAdminBypass().
   */
  tenantId?: string;
  /** Filter by secret name */
  secretName?: string;
  /** Filter by user ID */
  userId?: string;
  /** Filter by action type */
  action?: SecretAuditAction;
  /** Filter by result */
  result?: SecretAuditResult;
  /** Filter by date range start */
  since?: Date;
  /** Filter by date range end */
  until?: Date;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Collection for managing SecretAuditLog objects
 */
export class SecretAuditLogCollection extends SmrtCollection<SecretAuditLog> {
  static readonly _itemClass = SecretAuditLog;

  /**
   * List audit logs with filtering options
   */
  async listLogs(
    options: ListAuditLogsOptions = {},
  ): Promise<SecretAuditLog[]> {
    const where: Record<string, unknown> = {};

    if (options.tenantId) {
      where.tenantId = options.tenantId;
    }

    if (options.secretName) {
      where.secretName = options.secretName;
    }

    if (options.userId) {
      where.userId = options.userId;
    }

    if (options.action) {
      where.action = options.action;
    }

    if (options.result) {
      where.result = options.result;
    }

    if (options.since) {
      where['created_at >'] = options.since.toISOString();
    }

    if (options.until) {
      where['created_at <'] = options.until.toISOString();
    }

    return this.list({
      where,
      limit: options.limit ?? 100,
      offset: options.offset,
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Get audit logs for a specific secret.
   *
   * @param tenantId - Scope to this tenant's audit trail, or `null` for a
   *   cross-tenant compliance query (which must run under
   *   `withSuperAdminBypass()` from `@happyvertical/smrt-tenancy`). Audit rows
   *   reference secret names and must not leak across tenants (#1503).
   */
  async getSecretHistory(
    tenantId: string | null,
    secretName: string,
    limit: number = 50,
  ): Promise<SecretAuditLog[]> {
    return this.listLogs({ tenantId: tenantId ?? undefined, secretName, limit });
  }

  /**
   * Get audit logs for a specific user.
   *
   * @param tenantId - Scope to this tenant's audit trail, or `null` for a
   *   cross-tenant compliance query under `withSuperAdminBypass()` (#1503).
   */
  async getUserActivity(
    tenantId: string | null,
    userId: string,
    limit: number = 50,
  ): Promise<SecretAuditLog[]> {
    return this.listLogs({ tenantId: tenantId ?? undefined, userId, limit });
  }

  /**
   * Get recent failures.
   *
   * @param tenantId - Scope to this tenant's audit trail, or `null` for a
   *   cross-tenant compliance query under `withSuperAdminBypass()` (#1503).
   */
  async getRecentFailures(
    tenantId: string | null,
    limit: number = 20,
  ): Promise<SecretAuditLog[]> {
    return this.listLogs({
      tenantId: tenantId ?? undefined,
      result: 'failure',
      limit,
    });
  }

  /**
   * Get recent denied access attempts.
   *
   * @param tenantId - Scope to this tenant's audit trail, or `null` for a
   *   cross-tenant compliance query under `withSuperAdminBypass()` (#1503).
   */
  async getRecentDenials(
    tenantId: string | null,
    limit: number = 20,
  ): Promise<SecretAuditLog[]> {
    return this.listLogs({
      tenantId: tenantId ?? undefined,
      result: 'denied',
      limit,
    });
  }

  /**
   * Count operations by action type.
   *
   * @param tenantId - Scope to this tenant's audit trail, or `null` for a
   *   cross-tenant compliance count under `withSuperAdminBypass()` (#1503).
   */
  async countByAction(
    tenantId: string | null,
    since?: Date,
  ): Promise<Record<SecretAuditAction, number>> {
    const logs = await this.listLogs({
      tenantId: tenantId ?? undefined,
      since,
      limit: 10000,
    });

    const counts: Record<SecretAuditAction, number> = {
      create: 0,
      read: 0,
      update: 0,
      delete: 0,
      rotate_key: 0,
      disable: 0,
      enable: 0,
      expire: 0,
    };

    for (const log of logs) {
      counts[log.action]++;
    }

    return counts;
  }

  /**
   * Count operations by result.
   *
   * @param tenantId - Scope to this tenant's audit trail, or `null` for a
   *   cross-tenant compliance count under `withSuperAdminBypass()` (#1503).
   */
  async countByResult(
    tenantId: string | null,
    since?: Date,
  ): Promise<Record<SecretAuditResult, number>> {
    const logs = await this.listLogs({
      tenantId: tenantId ?? undefined,
      since,
      limit: 10000,
    });

    const counts: Record<SecretAuditResult, number> = {
      success: 0,
      failure: 0,
      denied: 0,
    };

    for (const log of logs) {
      counts[log.result]++;
    }

    return counts;
  }

  /**
   * Delete old audit logs
   * @param olderThanDays Delete logs older than this many days
   */
  async cleanup(olderThanDays: number = 365): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const oldLogs = await this.list({
      where: {
        'created_at <': cutoffDate.toISOString(),
      },
    });

    let count = 0;
    for (const log of oldLogs) {
      await log.delete();
      count++;
    }

    return count;
  }
}
