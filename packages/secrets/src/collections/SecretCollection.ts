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
 */
export class SecretCollection extends SmrtCollection<Secret> {
  static readonly _itemClass = Secret;

  /**
   * Find a secret by name within the current tenant context
   */
  async findByName(name: string): Promise<Secret | null> {
    return this.get({ name });
  }

  /**
   * List secrets with filtering options
   */
  async listSecrets(options: ListSecretsOptions = {}): Promise<Secret[]> {
    const where: Record<string, unknown> = {};

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
   * List all active secrets
   */
  async listActive(): Promise<Secret[]> {
    return this.listSecrets({ status: 'active' });
  }

  /**
   * List secrets by category
   */
  async listByCategory(category: string): Promise<Secret[]> {
    return this.listSecrets({ category, status: 'active' });
  }

  /**
   * List secrets that need attention (expired or about to expire)
   */
  async listExpiring(daysAhead: number = 30): Promise<Secret[]> {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + daysAhead);

    const secrets = await this.list({
      where: {
        status: 'active',
        'expiresAt !=': null,
        'expiresAt <': futureDate.toISOString(),
      },
      orderBy: 'expiresAt ASC',
    });

    return secrets;
  }

  /**
   * Get categories used in secrets
   */
  async getCategories(): Promise<string[]> {
    const secrets = await this.list({});
    const categories = new Set(secrets.map((s) => s.category).filter(Boolean));
    return Array.from(categories).sort();
  }

  /**
   * Count secrets by status
   */
  async countByStatus(): Promise<Record<SecretStatus, number>> {
    const secrets = await this.list({});

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
   * Delete a secret by name
   */
  async deleteByName(name: string): Promise<boolean> {
    const secret = await this.findByName(name);
    if (!secret) return false;

    await secret.delete();
    return true;
  }
}
