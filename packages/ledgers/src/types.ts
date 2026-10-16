/**
 * Type definitions for smrt-ledgers
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';

/**
 * Epsilon value for floating-point balance comparisons.
 * Used to determine if debits and credits are balanced.
 */
export const BALANCE_EPSILON = 0.001;

/**
 * The five core account types in double-entry accounting
 */
export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';

/**
 * Journal status lifecycle
 */
export type JournalStatus = 'draft' | 'posted' | 'voided';

export type LedgerBalanceMode = 'tolerant' | 'exact-integer';

export interface LedgerOptions extends SmrtClassOptions {
  tenantId?: string | null;
  name?: string;
  currency?: string;
  balanceMode?: LedgerBalanceMode;
}

/**
 * Options for creating an Account
 */
export interface AccountOptions extends SmrtClassOptions {
  tenantId?: string | null;
  number?: string;
  name?: string;
  description?: string;
  type?: AccountType;
  parentId?: string | null;
  ledgerId?: string | null;
  active?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a Journal
 */
export interface JournalOptions extends SmrtClassOptions {
  tenantId?: string | null;
  number?: string;
  date?: Date;
  description?: string;
  sourceModule?: string;
  sourceRef?: string | null;
  ledgerId?: string | null;
  idempotencyKey?: string | null;
  requestDigest?: string | null;
  status?: JournalStatus;
  postedAt?: Date | null;
  voidedAt?: Date | null;
  voidReason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Options for creating a JournalEntry
 */
export interface JournalEntryOptions extends SmrtClassOptions {
  tenantId?: string | null;
  journalId?: string;
  accountId?: string;
  counterpartyKind?: string | null;
  counterpartyId?: string | null;
  dueDate?: Date | null;
  settlesSourceRef?: string | null;
  debit?: number;
  credit?: number;
  currency?: string;
  exchangeRate?: number;
  memo?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A row in the trial balance report
 */
export interface TrialBalanceRow {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: AccountType;
  debitBalance: number;
  creditBalance: number;
}

/**
 * Account tree node for hierarchical display
 */
export interface AccountTreeNode {
  account: import('./models/Account').Account;
  children: AccountTreeNode[];
}

/**
 * Account tree structure
 */
export interface AccountTree {
  roots: AccountTreeNode[];
}

/**
 * Entry data for creating journal entries
 */
export interface JournalEntryData {
  accountId: string;
  counterpartyKind?: string | null;
  counterpartyId?: string | null;
  dueDate?: Date | null;
  settlesSourceRef?: string | null;
  debit?: number;
  credit?: number;
  currency?: string;
  exchangeRate?: number;
  memo?: string;
}

/**
 * Data for creating a complete journal with entries
 */
export interface CreateJournalData {
  tenantId?: string | null;
  date?: Date;
  description: string;
  sourceModule?: string;
  sourceRef?: string | null;
  ledgerId?: string | null;
  idempotencyKey?: string | null;
  requestDigest?: string | null;
  entries: JournalEntryData[];
  metadata?: Record<string, unknown>;
}
