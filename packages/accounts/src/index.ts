/**
 * @have/accounts
 *
 * Flexible accounting ledger with multi-currency support and SMRT framework integration
 *
 * @packageDocumentation
 */

// Export models
export { Account } from './models/Account';
export { AccountTransaction } from './models/AccountTransaction';
export { AccountTransactionEntry } from './models/AccountTransactionEntry';

// Export collections
export { AccountCollection } from './collections/AccountCollection';
export { AccountTransactionCollection } from './collections/AccountTransactionCollection';
export { AccountTransactionEntryCollection } from './collections/AccountTransactionEntryCollection';

// Export types
export type {
  AccountType,
  CurrencyCode,
  AccountOptions,
  AccountTransactionOptions,
  AccountTransactionEntryOptions,
  AccountSearchFilters,
  AccountTransactionSearchFilters,
  AccountTransactionEntrySearchFilters,
} from './types';
