/**
 * TenantIntegrationCollection - accessors for tenant integration rows.
 *
 * @packageDocumentation
 */

import {
  isUniqueViolationError,
  SmrtCollection,
} from '@happyvertical/smrt-core';
import {
  TenantIntegration,
  type TenantIntegrationProvider,
} from '../models/TenantIntegration.js';

export class TenantIntegrationCollection extends SmrtCollection<TenantIntegration> {
  static readonly _itemClass = TenantIntegration;

  async listForTenant(tenantId: string): Promise<TenantIntegration[]> {
    return this.list({
      where: { tenantId },
      orderBy: 'provider ASC',
    });
  }

  async findFor(
    tenantId: string,
    provider: TenantIntegrationProvider,
  ): Promise<TenantIntegration | null> {
    return this.findOne({
      where: { tenantId, provider },
    }) as Promise<TenantIntegration | null>;
  }

  async findOrInit(
    tenantId: string,
    provider: TenantIntegrationProvider,
  ): Promise<TenantIntegration> {
    const existing = await this.findFor(tenantId, provider);
    if (existing) {
      return existing;
    }

    try {
      return await this.create({
        tenantId,
        provider,
        status: 'unprovisioned',
        _insertOnly: true,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) {
        throw err;
      }

      const winner = await this.findFor(tenantId, provider);
      if (winner) {
        return winner;
      }

      throw err;
    }
  }
}

/**
 * Detect the losing side of a concurrent `findOrInit` race.
 *
 * Reduced to the framework contract in #2366: the hand-rolled cause walk and
 * its dialect regexes were a workaround for `save()` surfacing constraint
 * violations as a generic `DatabaseError`. Core now classifies through the
 * driver-error chain, so the typed check is sufficient.
 */
function isDuplicateKeyError(err: unknown): boolean {
  return isUniqueViolationError(err);
}
