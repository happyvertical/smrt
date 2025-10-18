# @smrt/accounts

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Flexible accounting ledger with multi-currency support and SMRT framework integration.

## Overview

The `@smrt/accounts` package provides a complete double-entry accounting system built on the SMRT framework. It supports multi-currency transactions, hierarchical account organization, and automatic balance calculation with type-safe operations and database persistence.

The package follows standard accounting principles with five account types: **assets**, **liabilities**, **equity**, **revenue**, and **expense**. Each transaction consists of multiple entries that must balance (total debits equal total credits), ensuring data integrity through double-entry bookkeeping.

## Features

- **Double-Entry Bookkeeping**: Automatic validation of balanced transactions
- **Multi-Currency Support**: ISO 4217 currency codes with per-transaction currency handling
- **Hierarchical Accounts**: Organize accounts in parent-child relationships with unlimited nesting
- **Type-Safe Operations**: Full TypeScript support with comprehensive type definitions
- **Automatic Balance Calculation**: Real-time balance computation for accounts and transactions
- **Metadata Support**: Store additional JSON metadata on accounts and transactions
- **SMRT Integration**: Auto-generated REST APIs, CLI commands, and MCP tools
- **Query Capabilities**: Filter by type, currency, date ranges, and hierarchy
- **Amount Precision**: Integer-based amounts in smallest currency unit (e.g., cents) to avoid floating-point errors

## Installation

```bash
# Install with pnpm (recommended)
pnpm add @smrt/accounts

# Or with npm
npm install @smrt/accounts

# Or with yarn
yarn add @smrt/accounts
```

## Usage

### Creating Accounts

```typescript
import { Account, AccountCollection } from '@smrt/accounts';

// Create a collection
const accounts = await AccountCollection.create({
  persistence: true,
  db: { type: 'sqlite', path: './accounting.db' }
});

// Create root accounts
const cashAccount = await accounts.create({
  name: 'Cash',
  slug: 'cash',
  type: 'asset',
  currency: 'USD',
  description: 'Cash on hand and in bank accounts'
});

const revenueAccount = await accounts.create({
  name: 'Sales Revenue',
  slug: 'sales-revenue',
  type: 'revenue',
  currency: 'USD',
  description: 'Revenue from product sales'
});

// Create child account with hierarchy
const checkingAccount = await accounts.create({
  name: 'Checking Account',
  slug: 'checking',
  type: 'asset',
  currency: 'USD',
  parentId: cashAccount.id,
  description: 'Primary business checking account'
});
```

### Recording Transactions

```typescript
import {
  AccountTransaction,
  AccountTransactionCollection,
  AccountTransactionEntry,
  AccountTransactionEntryCollection
} from '@smrt/accounts';

// Create transaction collections
const transactions = await AccountTransactionCollection.create({
  persistence: true,
  db: { type: 'sqlite', path: './accounting.db' }
});

const entries = await AccountTransactionEntryCollection.create({
  persistence: true,
  db: { type: 'sqlite', path: './accounting.db' }
});

// Create a sale transaction
const saleTransaction = await transactions.create({
  date: new Date('2025-01-15'),
  description: 'Sale of products to customer',
  metadata: { invoiceNumber: 'INV-001', customerId: 'CUST-123' }
});

// Create debit entry (increase cash)
const debitEntry = await entries.create({
  transactionId: saleTransaction.id,
  accountId: cashAccount.id,
  amount: 10000, // $100.00 in cents
  currency: 'USD',
  description: 'Cash received'
});

// Create credit entry (increase revenue)
const creditEntry = await entries.create({
  transactionId: saleTransaction.id,
  accountId: revenueAccount.id,
  amount: -10000, // Negative for credit
  currency: 'USD',
  description: 'Product sales'
});

// Verify transaction is balanced
const isBalanced = await saleTransaction.isBalanced();
console.log('Transaction balanced:', isBalanced); // true
```

### Using Helper Methods

```typescript
// Create entries using helper methods
const debitEntry = AccountTransactionEntry.createDebit({
  transactionId: transaction.id,
  accountId: cashAccount.id,
  amount: 5000, // Automatically made positive
  currency: 'USD'
});

const creditEntry = AccountTransactionEntry.createCredit({
  transactionId: transaction.id,
  accountId: revenueAccount.id,
  amount: 5000, // Automatically made negative
  currency: 'USD'
});
```

### Account Balances and Queries

```typescript
// Get account balance
const balance = await cashAccount.getBalance();
console.log(`Cash balance: $${balance / 100}`);

// Get all transaction entries for an account
const entries = await cashAccount.getTransactionEntries();

// Query accounts by type
const assetAccounts = await accounts.getByType('asset');

// Query accounts by currency
const usdAccounts = await accounts.getByCurrency('USD');

// Search accounts by name
const searchResults = await accounts.searchByName('cash');
```

### Working with Account Hierarchies

```typescript
// Get account hierarchy
const hierarchy = await checkingAccount.getHierarchy();
console.log('Ancestors:', hierarchy.ancestors); // [cashAccount]
console.log('Current:', hierarchy.current); // checkingAccount
console.log('Descendants:', hierarchy.descendants); // []

// Get all child accounts
const children = await cashAccount.getChildren();

// Get all descendant accounts (recursive)
const allDescendants = await cashAccount.getDescendants();

// Get depth in hierarchy
const depth = await checkingAccount.getDepth(); // 1

// Check if root account
const isRoot = cashAccount.isRoot(); // true

// Get tree structure of all accounts
const tree = await accounts.getHierarchyTree();
```

### Multi-Currency Support

```typescript
// Create accounts in different currencies
const eurAccount = await accounts.create({
  name: 'Euro Cash',
  slug: 'euro-cash',
  type: 'asset',
  currency: 'EUR'
});

const gbpAccount = await accounts.create({
  name: 'Pound Cash',
  slug: 'pound-cash',
  type: 'asset',
  currency: 'GBP'
});

// Create multi-currency transaction
const forexTransaction = await transactions.create({
  description: 'Currency exchange USD to EUR'
});

// Each entry can have its own currency
await entries.create({
  transactionId: forexTransaction.id,
  accountId: cashAccount.id,
  amount: -10000, // -$100.00 USD
  currency: 'USD'
});

await entries.create({
  transactionId: forexTransaction.id,
  accountId: eurAccount.id,
  amount: 9200, // €92.00 EUR
  currency: 'EUR'
});

// Group entries by currency
const entriesByCurrency = await forexTransaction.getEntriesByCurrency();
```

### Transaction Analysis

```typescript
// Get transaction details
const totalDebits = await transaction.getTotalDebits();
const totalCredits = await transaction.getTotalCredits();
const balance = await transaction.getBalance();

console.log(`Debits: $${totalDebits / 100}`);
console.log(`Credits: $${totalCredits / 100}`);
console.log(`Balance: $${balance / 100}`);

// Get all entries for a transaction
const allEntries = await transaction.getEntries();

// Check entry type
if (entry.isDebit()) {
  console.log('This is a debit entry');
}

if (entry.isCredit()) {
  console.log('This is a credit entry');
}

// Format entry amount
console.log(entry.formatAmount('en-US')); // "$100.00"
console.log(entry.formatAmount('de-DE')); // "100,00 €"
```

### Metadata Management

```typescript
// Set metadata on account
cashAccount.setMetadata({
  bankName: 'First National Bank',
  accountNumber: '****1234',
  routingNumber: '123456789'
});

// Update metadata (merges with existing)
cashAccount.updateMetadata({
  lastReconciled: '2025-01-15'
});

// Get metadata
const metadata = cashAccount.getMetadata();
console.log(metadata.bankName); // "First National Bank"

// Metadata also works on transactions
transaction.setMetadata({
  source: 'pos-system',
  location: 'Store #1',
  cashier: 'John Doe'
});
```

### Advanced Queries

```typescript
// Get accounts by type and currency
const usdAssets = await accounts.getByTypeAndCurrency('asset', 'USD');

// Get root accounts
const rootAccounts = await accounts.getRootAccounts();

// Get children of a specific account
const subAccounts = await accounts.getChildren(parentAccountId);

// Filter transaction entries
const largeEntries = await entries.list({
  where: {
    accountId: cashAccount.id,
    amount: { gte: 100000 } // Greater than $1000
  }
});
```

## API Reference

For complete API documentation, see the generated TypeDoc documentation at `/api/accounts/globals`.

### Core Classes

- **Account**: Financial account with hierarchical support
- **AccountTransaction**: Financial transaction record
- **AccountTransactionEntry**: Individual debit or credit entry
- **AccountCollection**: Collection manager for accounts
- **AccountTransactionCollection**: Collection manager for transactions
- **AccountTransactionEntryCollection**: Collection manager for entries

### Type Definitions

- **AccountType**: `'asset' | 'liability' | 'equity' | 'revenue' | 'expense'`
- **CurrencyCode**: ISO 4217 currency code string (e.g., 'USD', 'EUR', 'GBP')

## License

This package is part of the SMRT Framework and is licensed under the MIT License - see the [LICENSE](_media/LICENSE) file for details.
