/**
 * EmailAccountCollection - Collection manager for EmailAccount objects
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { EmailAccount } from '../models/EmailAccount';
import type { EmailAccountSearchFilters, ProviderType } from '../types';

export class EmailAccountCollection extends SmrtCollection<EmailAccount> {
  static readonly _itemClass = EmailAccount;

  /**
   * Get account by email address
   */
  async getByEmail(email: string): Promise<EmailAccount | null> {
    const accounts = await this.list({ where: { email } });
    return accounts[0] || null;
  }

  /**
   * Get accounts by provider type
   */
  async getByProviderType(providerType: ProviderType): Promise<EmailAccount[]> {
    return await this.list({ where: { providerType } });
  }

  /**
   * Get active accounts
   */
  async getActive(): Promise<EmailAccount[]> {
    return await this.list({ where: { isActive: true } });
  }

  /**
   * Get inactive accounts
   */
  async getInactive(): Promise<EmailAccount[]> {
    return await this.list({ where: { isActive: false } });
  }

  /**
   * Get accounts that need syncing
   */
  async getNeedingSync(maxAgeMinutes = 60): Promise<EmailAccount[]> {
    const allAccounts = await this.getActive();
    const cutoffTime = new Date(Date.now() - maxAgeMinutes * 60 * 1000);

    return allAccounts.filter(
      (account) => !account.lastSyncAt || account.lastSyncAt < cutoffTime,
    );
  }

  /**
   * Search accounts with filters
   */
  async search(
    query: string,
    filters?: EmailAccountSearchFilters,
  ): Promise<EmailAccount[]> {
    let accounts = await this.list({});

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
   * Sync all active accounts
   */
  async syncAll(
    options?: Record<string, any>,
  ): Promise<Map<string, { success: boolean; error?: Error }>> {
    const results = new Map<string, { success: boolean; error?: Error }>();
    const accounts = await this.getActive();

    for (const account of accounts) {
      const accountId = account.id ?? account.email ?? 'unknown';
      try {
        await account.syncFrom(options);
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
   * Get total unread count across all accounts
   */
  async getTotalUnreadCount(): Promise<number> {
    const accounts = await this.getActive();
    let total = 0;

    for (const account of accounts) {
      total += await account.getUnreadCount();
    }

    return total;
  }

  /**
   * Get account statistics
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    inactive: number;
    byProvider: Record<ProviderType, number>;
  }> {
    const accounts = await this.list({});

    const byProvider: Record<ProviderType, number> = {
      smtp: 0,
      imap: 0,
      pop3: 0,
      gmail: 0,
    };

    for (const account of accounts) {
      byProvider[account.providerType]++;
    }

    return {
      total: accounts.length,
      active: accounts.filter((a) => a.isActive).length,
      inactive: accounts.filter((a) => !a.isActive).length,
      byProvider,
    };
  }
}
