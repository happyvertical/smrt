/**
 * Account model - Financial account with hierarchical support
 *
 * Represents a category of economic activity (asset, liability, equity, revenue, expense)
 */

import { SmrtObject, smrt } from '@have/smrt';
import type { AccountOptions, AccountType, CurrencyCode } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Account extends SmrtObject {
  // id, slug, name inherited from SmrtObject

  type: AccountType = 'asset';
  currency: CurrencyCode = 'USD'; // Default to USD, should be set explicitly
  parentId = ''; // FK to parent Account (nullable for root accounts)
  description = '';
  metadata = ''; // JSON metadata (stored as text)

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: AccountOptions = {}) {
    super(options);

    if (options.type !== undefined) this.type = options.type;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.description !== undefined)
      this.description = options.description;

    // Handle metadata - can be object or JSON string
    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }

    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get metadata as parsed object
   *
   * @returns Parsed metadata object or empty object
   */
  getMetadata(): Record<string, any> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   *
   * @param data - Metadata object to store
   */
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   *
   * @param updates - Partial metadata to merge
   */
  updateMetadata(updates: Record<string, any>): void {
    const current = this.getMetadata();
    this.setMetadata({ ...current, ...updates });
  }

  /**
   * Get the parent account
   *
   * @returns Parent Account instance or null
   */
  async getParent(): Promise<Account | null> {
    if (!this.parentId) return null;

    const { AccountCollection } = await import(
      '../collections/AccountCollection'
    );
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = new AccountCollection({
      persistence,
      db,
      ai,
      fs,
      _className,
    });
    await collection.initialize();

    return await collection.get({ id: this.parentId });
  }

  /**
   * Get immediate child accounts
   *
   * @returns Array of child Account instances
   */
  async getChildren(): Promise<Account[]> {
    const { AccountCollection } = await import(
      '../collections/AccountCollection'
    );
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = new AccountCollection({
      persistence,
      db,
      ai,
      fs,
      _className,
    });
    await collection.initialize();

    return await collection.list({ where: { parentId: this.id } });
  }

  /**
   * Get all ancestor accounts (recursive)
   *
   * @returns Array of ancestor accounts from root to immediate parent
   */
  async getAncestors(): Promise<Account[]> {
    const ancestors: Account[] = [];
    let currentAccount: Account | null = this;

    while (currentAccount && currentAccount.parentId) {
      const parent = await currentAccount.getParent();
      if (!parent) break;
      ancestors.unshift(parent); // Add to beginning
      currentAccount = parent;
    }

    return ancestors;
  }

  /**
   * Get all descendant accounts (recursive)
   *
   * @returns Array of all descendant accounts
   */
  async getDescendants(): Promise<Account[]> {
    const children = await this.getChildren();
    const descendants: Account[] = [...children];

    for (const child of children) {
      const childDescendants = await child.getDescendants();
      descendants.push(...childDescendants);
    }

    return descendants;
  }

  /**
   * Get root account (top-level account with no parent)
   *
   * @returns Root account instance
   */
  async getRootAccount(): Promise<Account> {
    const ancestors = await this.getAncestors();
    return ancestors.length > 0 ? ancestors[0] : this;
  }

  /**
   * Get full hierarchy for this account
   *
   * @returns Object with ancestors, current, and descendants
   */
  async getHierarchy(): Promise<{
    ancestors: Account[];
    current: Account;
    descendants: Account[];
  }> {
    const [ancestors, descendants] = await Promise.all([
      this.getAncestors(),
      this.getDescendants(),
    ]);

    return {
      ancestors,
      current: this,
      descendants,
    };
  }

  /**
   * Check if account is a root account (no parent)
   *
   * @returns True if parentId is empty
   */
  isRoot(): boolean {
    return !this.parentId;
  }

  /**
   * Get the depth of this account in the hierarchy
   *
   * @returns Number of ancestors (0 for root accounts)
   */
  async getDepth(): Promise<number> {
    const ancestors = await this.getAncestors();
    return ancestors.length;
  }

  /**
   * Get all transaction entries for this account
   *
   * @returns Array of AccountTransactionEntry instances
   */
  async getTransactionEntries() {
    const { AccountTransactionEntryCollection } = await import(
      '../collections/AccountTransactionEntryCollection'
    );
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = new AccountTransactionEntryCollection({
      persistence,
      db,
      ai,
      fs,
      _className,
    });
    await collection.initialize();

    return await collection.list({ where: { accountId: this.id } });
  }

  /**
   * Calculate the balance for this account
   * Sum of all transaction entries (debits positive, credits negative)
   *
   * @returns Balance in smallest currency unit (e.g., cents)
   */
  async getBalance(): Promise<number> {
    const entries = await this.getTransactionEntries();
    return entries.reduce((sum, entry) => sum + entry.amount, 0);
  }
}
