/**
 * SecretCollection - Collection manager for Secret objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Secret, type SecretStatus } from '../models/Secret.js';

/**
 * Options for listing secrets
 */
export interface ListSecretsOptions {
  /** Filter by category */
  category?: string;
  /** Filter by status */
  status?: SecretStatus;
  /** Include expired secrets */
  includeExpired?: boolean;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Collection for managing Secret objects
 *
 * All lookups take an explicit `tenantId` and scope on the authoritative
 * `tenant_id` column. Scoping must NOT rely on the tenancy interceptor
 * (which may be disabled in the host application) and must NOT use the
 * `context` column: `context = tenantId` is only a convention applied on
 * the create path, so pre-convention rows may have a divergent `context`.
 * See https://github.com/happyvertical/smrt/issues/1501
 */
export class SecretCollection extends SmrtCollection<Secret> {
  static readonly _itemClass = Secret;

  /**
   * Find a secret by name within the given tenant
   */
  async findByName(tenantId: string, name: string): Promise<Secret | null> {
    return this.get({ name, tenantId });
  }

  /**
   * List secrets for a tenant with filtering options
   */
  async listSecrets(
    tenantId: string,
    options: ListSecretsOptions = {},
  ): Promise<Secret[]> {
    const where: Record<string, unknown> = { tenantId };

    if (options.category) {
      where.category = options.category;
    }

    if (options.status) {
      where.status = options.status;
    }

    const secrets = await this.list({
      where,
      limit: options.limit,
      offset: options.offset,
      orderBy: 'name ASC',
    });

    // Filter out expired secrets unless explicitly included
    if (!options.includeExpired) {
      return secrets.filter((secret) => !secret.isExpired());
    }

    return secrets;
  }

  /**
   * List all active secrets for a tenant
   */
  async listActive(tenantId: string): Promise<Secret[]> {
    return this.listSecrets(tenantId, { status: 'active' });
  }

  /**
   * List a tenant's secrets by category
   */
  async listByCategory(tenantId: string, category: string): Promise<Secret[]> {
    return this.listSecrets(tenantId, { category, status: 'active' });
  }

  /**
   * List a tenant's secrets that need attention (expired or about to expire)
   */
  async listExpiring(
    tenantId: string,
    daysAhead: number = 30,
  ): Promise<Secret[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);

    const secrets = await this.list({
      where: {
        tenantId,
        status: 'active',
        'expiresAt !=': null,
        'expiresAt <': futureDate.toISOString(),
      },
      orderBy: 'expiresAt ASC',
    });

    return secrets;
  }

  /**
   * Get categories used in a tenant's secrets
   */
  async getCategories(tenantId: string): Promise<string[]> {
    const secrets = await this.list({ where: { tenantId } });
    const categories = new Set(secrets.map((s) => s.category).filter(Boolean));
    return Array.from(categories).sort();
  }

  /**
   * Count a tenant's secrets by status
   */
  async countByStatus(tenantId: string): Promise<Record<SecretStatus, number>> {
    const secrets = await this.list({ where: { tenantId } });

    const counts: Record<SecretStatus, number> = {
      active: 0,
      disabled: 0,
      expired: 0,
    };

    for (const secret of secrets) {
      if (secret.isExpired()) {
        counts.expired++;
      } else {
        counts[secret.status]++;
      }
    }

    return counts;
  }

  /**
   * Delete a tenant's secret by name
   */
  async deleteByName(tenantId: string, name: string): Promise<boolean> {
    const secret = await this.findByName(tenantId, name);
    if (!secret) return false;

    await secret.delete();
    return true;
  }
}
