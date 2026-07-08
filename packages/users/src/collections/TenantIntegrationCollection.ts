/**
 * TenantIntegrationCollection - accessors for tenant integration rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
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

function isDuplicateKeyError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;

  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (e.code === '23505' || e.code === 'VALIDATION_UNIQUE_CONSTRAINT') {
      return true;
    }

    const message = typeof e.message === 'string' ? e.message : '';
    if (
      /duplicate key|unique.+violat|code=23505|SQLITE_CONSTRAINT.*UNIQUE/i.test(
        message,
      )
    ) {
      return true;
    }

    cur = e.cause;
  }

  return false;
}
