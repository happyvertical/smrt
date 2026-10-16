/**
 * Account model - Chart of accounts entry
 *
 * Represents a single account in the chart of accounts.
 * The 5 core types: Asset, Liability, Equity, Revenue, Expense
 */

import {
  field,
  foreignKey,
  SmrtHierarchical,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  isSuperAdminBypass,
  isTenancyEnabled,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { AccountOptions, AccountTreeNode, AccountType } from '../types';
import { Ledger } from './Ledger';

@TenantScoped({ mode: 'optional' })
@smrt({
  // Own table, never the derived `accounts`: smrt-messages declares an
  // unrelated `Account` on that table (#3098). Existing `accounts`-hosted
  // ledgers move with `smrt db:migrate-ledger-accounts`.
  tableName: 'ledger_accounts',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { skipApiCheck: true },
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
  @field({ description: 'The account number in your chart of accounts.' })
  number: string = '';

  /**
   * Account name (e.g., "Cash", "Coffee Expense")
   */
  @field({ description: 'What the account is called.' })
  name: string = '';

  /**
   * Account description
   */
  @field({ description: 'What the account is used for.' })
  description: string = '';

  /**
   * Account type - one of the 5 core types
   */
  @field({ description: 'asset, liability, equity, revenue or expense.' })
  type: AccountType = 'asset';

  /** Accounting scope; null is a legacy account usable only by legacy journals. */
  @foreignKey(Ledger)
  ledgerId: string | null = null;

  // parentId inherited from SmrtHierarchical (null = top-level)

  /**
   * Whether the account is active
   */
  @field({
    description:
      'Whether the account is in use; deactivate it instead of deleting it.',
  })
  active: boolean = true;

  /**
   * Extensible metadata
   */
  metadata: Record<string, unknown> = {};

  constructor(options: AccountOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.number !== undefined) this.number = options.number;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.type !== undefined) this.type = options.type;
    if (options.ledgerId !== undefined) this.ledgerId = options.ledgerId;
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.active !== undefined) this.active = options.active;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    if (this.ledgerId) {
      const { LedgerCollection } = await import('../collections/Ledgers');
      const ledger = await (await LedgerCollection.create(this.options)).get(
        { id: this.ledgerId },
        { cache: false },
      );
      // Model validation precedes optional tenancy auto-population.
      const owner =
        this.tenantId ??
        (isTenancyEnabled() && !isSuperAdminBypass()
          ? (getTenantId() ?? null)
          : null);
      if (!ledger || ledger.tenantId !== owner)
        throw new Error(
          'Scoped account requires an accessible ledger with the same owner',
        );
    }
    if (this.id) {
      const stored = await this.db.get(this.tableName, { id: this.id });
      if (
        stored &&
        (stored.ledger_id !== this.ledgerId ||
          (stored.ledger_id &&
            (stored.tenant_id !== this.tenantId || stored.type !== this.type)))
      )
        throw new Error('Ledger account scope, owner and type are immutable');
    }
  }

  async delete(
    options: Parameters<SmrtHierarchical['delete']>[0] = {},
  ): Promise<void> {
    const stored = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (stored?.ledger_id)
      throw new Error(
        'Ledger accounts cannot be deleted; deactivate them instead',
      );
    await super.delete(options);
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
    const parent = await collection.get({ id: this.id }, { cache: false });
    if (!parent)
      throw new Error('Parent account must be persisted and accessible');
    if (
      parent.ledgerId &&
      ((options.ledgerId !== undefined &&
        options.ledgerId !== parent.ledgerId) ||
        (options.tenantId !== undefined &&
          options.tenantId !== parent.tenantId))
    )
      throw new Error(
        'Scoped children must inherit the parent ledger and owner',
      );
    const account = await collection.create({
      ...options,
      ...(parent.ledgerId
        ? { ledgerId: parent.ledgerId, tenantId: parent.tenantId }
        : {}),
      parentId: parent.id,
      type: parent.type, // Inherit persisted type from parent
    });
    await account.save();
    return account;
  }
}
