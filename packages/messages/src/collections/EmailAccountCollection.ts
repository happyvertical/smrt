/**
 * EmailAccountCollection - Collection manager for EmailAccount objects
 *
 * Extends AccountCollection with email-specific query methods.
 */

import { EmailAccount } from '../models/EmailAccount';
import type { EmailAccountSearchFilters, ProviderType } from '../types';
import { AccountCollection } from './AccountCollection';

export class EmailAccountCollection extends AccountCollection {
  static override readonly _itemClass = EmailAccount;

  /**
   * Get account by email address
   */
  async getByEmail(email: string): Promise<EmailAccount | null> {
    const accounts = await this.list({ where: { email } });
    return (accounts[0] as EmailAccount) || null;
  }

  /**
   * Get accounts by email provider type
   */
  async getByEmailProviderType(
    providerType: ProviderType,
  ): Promise<EmailAccount[]> {
    return (await this.list({ where: { providerType } })) as EmailAccount[];
  }

  /**
   * Get active email accounts
   */
  override async getActive(): Promise<EmailAccount[]> {
    return (await this.list({ where: { isActive: true } })) as EmailAccount[];
  }

  /**
   * Get inactive email accounts
   */
  override async getInactive(): Promise<EmailAccount[]> {
    return (await this.list({ where: { isActive: false } })) as EmailAccount[];
  }

  /**
   * Get accounts that need syncing
   */
  async getNeedingSync(maxAgeMinutes = 60): Promise<EmailAccount[]> {
    const allAccounts = await this.getActive();
    const cutoffTime = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

    return allAccounts.filter(
      (account) => !account.lastSyncAt || account.lastSyncAt < cutoffTime,
    ) as EmailAccount[];
  }

  /**
   * Search email accounts with filters.
   * Alias: `search()` for backward compatibility.
   */
  override async search(
    query: string,
    filters?: EmailAccountSearchFilters,
  ): Promise<EmailAccount[]> {
    return this.searchEmailAccounts(query, filters);
  }

  /**
   * Get accounts by email provider type.
   * Alias: `getByProviderType()` for backward compatibility.
   */
  override async getByProviderType(
    providerType: string,
  ): Promise<EmailAccount[]> {
    return this.getByEmailProviderType(providerType as ProviderType);
  }

  /**
   * Get email account statistics.
   * Alias: `getStats()` for backward compatibility.
   */
  override async getStats(): Promise<{
    total: number;
    active: number;
    inactive: number;
    byType: Record<string, number>;
  }> {
    const stats = await this.getEmailStats();
    return {
      total: stats.total,
      active: stats.active,
      inactive: stats.inactive,
      byType: stats.byProvider as unknown as Record<string, number>,
    };
  }

  /**
   * Search email accounts with filters
   */
  async searchEmailAccounts(
    query: string,
    filters?: EmailAccountSearchFilters,
  ): Promise<EmailAccount[]> {
    let accounts = (await this.list({})) as EmailAccount[];

    // Filter by query
    if (query) {
      const lowerQuery = query.toLowerCase();
      accounts = accounts.filter(
        (a) =>
          a.name?.toLowerCase().includes(lowerQuery) ||
          a.email?.toLowerCase().includes(lowerQuery),
      );
    }

    // Apply filters
    if (filters) {
      if (filters.providerType) {
        accounts = accounts.filter(
          (a) => a.providerType === filters.providerType,
        );
      }
      if (filters.email) {
        const emailLower = filters.email.toLowerCase();
        accounts = accounts.filter((a) =>
          a.email?.toLowerCase().includes(emailLower),
        );
      }
      if (filters.isActive !== undefined) {
        accounts = accounts.filter((a) => a.isActive === filters.isActive);
      }
    }

    return accounts;
  }

  /**
   * Sync all active email accounts
   */
  async syncAll(
    options?: Record<string, any>,
  ): Promise<Map<string, { success: boolean; error?: Error }>> {
    const results = new Map<string, { success: boolean; error?: Error }>();
    const accounts = await this.getActive();

    for (const account of accounts) {
      const ea = account as EmailAccount;
      const accountId = ea.id ?? ea.email ?? 'unknown';
      try {
        await ea.syncFrom(options);
        results.set(accountId, { success: true });
      } catch (error) {
        results.set(accountId, {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }

    return results;
  }

  /**
   * Get total unread count across all email accounts
   */
  async getTotalUnreadCount(): Promise<number> {
    const accounts = await this.getActive();
    let total = 0;

    for (const account of accounts) {
      total += await (account as EmailAccount).getUnreadCount();
    }

    return total;
  }

  /**
   * Get email account statistics
   */
  async getEmailStats(): Promise<{
    total: number;
    active: number;
    inactive: number;
    byProvider: Record<ProviderType, number>;
  }> {
    const accounts = (await this.list({})) as EmailAccount[];

    const byProvider: Record<ProviderType, number> = {
      smtp: 0,
      imap: 0,
      pop3: 0,
      gmail: 0,
    };

    for (const account of accounts) {
      const pt = account.providerType as ProviderType;
      if (pt in byProvider) {
        byProvider[pt]++;
      }
    }

    return {
      total: accounts.length,
      active: accounts.filter((a) => a.isActive).length,
      inactive: accounts.filter((a) => !a.isActive).length,
      byProvider,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  override async findByTenant(tenantId: string): Promise<EmailAccount[]> {
    return this.list({ where: { tenantId } }) as Promise<EmailAccount[]>;
  }

  override async findGlobal(): Promise<EmailAccount[]> {
    return this.list({ where: { tenantId: null } }) as Promise<EmailAccount[]>;
  }

  override async findWithGlobals(tenantId: string): Promise<EmailAccount[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    ) as Promise<EmailAccount[]>;
  }
}
