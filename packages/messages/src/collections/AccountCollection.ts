/**
 * AccountCollection - Unified collection for polymorphic account queries
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Account } from '../models/Account';
import type { AccountSearchFilters } from '../types';

export class AccountCollection extends SmrtCollection<Account> {
  static readonly _itemClass = Account;

  /**
   * Get active accounts
   */
  async getActive(): Promise<Account[]> {
    return await this.list({ where: { isActive: true } });
  }

  /**
   * Get inactive accounts
   */
  async getInactive(): Promise<Account[]> {
    return await this.list({ where: { isActive: false } });
  }

  /**
   * Get accounts by provider type
   */
  async getByProviderType(providerType: string): Promise<Account[]> {
    return await this.list({ where: { providerType } });
  }

  /**
   * Get accounts by STI type
   */
  async getByType(accountType: string): Promise<Account[]> {
    return await this.list({ where: { _meta_type: accountType } });
  }

  /**
   * Search accounts with filters
   */
  async search(
    query: string,
    filters?: AccountSearchFilters,
  ): Promise<Account[]> {
    let accounts = await this.list({});

    if (query) {
      const lowerQuery = query.toLowerCase();
      accounts = accounts.filter((a) =>
        a.name?.toLowerCase().includes(lowerQuery),
      );
    }

    if (filters) {
      if (filters.providerType) {
        accounts = accounts.filter(
          (a) => a.providerType === filters.providerType,
        );
      }
      if (filters.isActive !== undefined) {
        accounts = accounts.filter((a) => a.isActive === filters.isActive);
      }
      if (filters.accountType) {
        accounts = accounts.filter((a) => {
          const metaType = (a as any)._meta_type || '';
          return metaType.includes(filters.accountType as string);
        });
      }
    }

    return accounts;
  }

  /**
   * Get account statistics
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    inactive: number;
    byType: Record<string, number>;
  }> {
    const accounts = await this.list({});
    const byType: Record<string, number> = {};

    for (const account of accounts) {
      const metaType = (account as any)._meta_type || 'Unknown';
      const shortType = metaType.split(':').pop() || metaType;
      byType[shortType] = (byType[shortType] || 0) + 1;
    }

    return {
      total: accounts.length,
      active: accounts.filter((a) => a.isActive).length,
      inactive: accounts.filter((a) => !a.isActive).length,
      byType,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  async findByTenant(tenantId: string): Promise<Account[]> {
    return this.list({ where: { tenantId } });
  }

  async findGlobal(): Promise<Account[]> {
    return this.list({ where: { tenantId: null } });
  }

  async findWithGlobals(tenantId: string): Promise<Account[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
