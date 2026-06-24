/**
 * Account model - Chart of accounts entry
 *
 * Represents a single account in the chart of accounts.
 * The 5 core types: Asset, Liability, Equity, Revenue, Expense
 */

import { SmrtHierarchical, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AccountOptions, AccountTreeNode, AccountType } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Account extends SmrtHierarchical {
  /**
   * Tenant ID for multi-tenancy support (nullable for global accounts)
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Account number (e.g., "1000", "5030")
   */
  number: string = '';

  /**
   * Account name (e.g., "Cash", "Coffee Expense")
   */
  name: string = '';

  /**
   * Account description
   */
  description: string = '';

  /**
   * Account type - one of the 5 core types
   */
  type: AccountType = 'asset';

  // parentId inherited from SmrtHierarchical (null = top-level)

  /**
   * Whether the account is active
   */
  active: boolean = true;

  /**
   * Extensible metadata
   */
  metadata: Record<string, unknown> = {};

  constructor(options: AccountOptions = {}) {
    super(options);
    if (options.number !== undefined) this.number = options.number;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.type !== undefined) this.type = options.type;
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.active !== undefined) this.active = options.active;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Check if this is a top-level account (no parent)
   */
  isTopLevel(): boolean {
    return this.parentId === null;
  }

  /**
   * Check if this is a debit-normal account (Asset, Expense)
   * Debit-normal accounts increase with debits
   */
  isDebitNormal(): boolean {
    return this.type === 'asset' || this.type === 'expense';
  }

  /**
   * Check if this is a credit-normal account (Liability, Equity, Revenue)
   * Credit-normal accounts increase with credits
   */
  isCreditNormal(): boolean {
    return (
      this.type === 'liability' ||
      this.type === 'equity' ||
      this.type === 'revenue'
    );
  }

  // Hierarchy traversal (getParent / getChildren / getAncestors /
  // getDescendants / getHierarchy / moveTo) provided by SmrtHierarchical.
  // Account-specific helpers (getFullPath / getBalance / createChild /
  // toTreeNode) remain below.

  /**
   * Get full account path (e.g., "Assets > Current > Cash")
   */
  async getFullPath(): Promise<string> {
    const ancestors = await this.getAncestors();
    const names = [...ancestors.map((a) => a.name), this.name];
    return names.join(' > ');
  }

  /**
   * Build tree node for this account and its children
   */
  async toTreeNode(): Promise<AccountTreeNode> {
    const children = await this.getChildren();
    const childNodes = await Promise.all(children.map((c) => c.toTreeNode()));
    return {
      account: this,
      children: childNodes,
    };
  }

  /**
   * Get the current balance of this account
   */
  async getBalance(asOfDate?: Date): Promise<number> {
    if (!this.id) return 0;
    const { JournalEntryCollection } = await import(
      '../collections/JournalEntries'
    );
    const collection = await JournalEntryCollection.create(this.options);
    return await collection.getAccountBalance(this.id, asOfDate);
  }

  /**
   * Create a sub-account under this account
   */
  async createChild(
    options: Omit<AccountOptions, 'parentId' | 'type'>,
  ): Promise<Account> {
    if (!this.id) {
      throw new Error('Account must be saved before creating children');
    }
    const { AccountCollection } = await import('../collections/Accounts');
    const collection = await AccountCollection.create(this.options);
    const account = await collection.create({
      ...options,
      parentId: this.id,
      type: this.type, // Inherit type from parent
    });
    await account.save();
    return account;
  }
}
