# @have/accounts Specification

## 1. Overview

This document outlines the specification for the `@have/accounts` module. The goal is to create a generic and extensible ledger system that can be used to track financial transactions, such as income and expenses, for any type of account.

The `@have/accounts` module will be built upon the `@have/smrt` core framework, and it will provide a set of `SmrtObject` classes for representing accounts, transactions, and other ledger-related data.

**Location:** `packages/accounts/` (SMRT modules are located in `packages/` following the monorepo structure)

## 2. Core Concepts

### 2.1. Flexible Transaction Recording

The `@have/accounts` module supports flexible transaction recording inspired by double-entry accounting principles but does not enforce strict balancing. This allows recording purchases, expenses, and other financial events without requiring corresponding balancing entries. Applications can implement their own validation logic as needed, but the core library focuses on flexible data capture.

### 2.2. Accounts

An `Account` represents a category of economic activity. Accounts can be of different types, such as `asset`, `liability`, `equity`, `revenue`, and `expense`. Accounts support a simple hierarchical structure via `parent_id`, with validation logic implemented at the application level rather than enforced by the library.

### 2.3. Transactions

A `AccountTransaction` represents a financial event. Each transaction will have a set of `AccountTransactionEntry` objects, which represent the debits and credits to the accounts.

## 3. Data Models

The data models will be implemented as `SmrtObject` classes, extending the base classes provided by the `@have/smrt` framework.

### 3.1. Account

The `Account` object will have the following properties:

- `id`: A unique identifier for the account.
- `name`: The name of the account (e.g., "Cash", "Accounts Receivable").
- `slug`: URL-friendly identifier (auto-generated from name).
- `type`: The type of the account (`asset`, `liability`, `equity`, `revenue`, `expense`).
- `currency`: ISO 4217 currency code (e.g., "USD", "EUR", "CAD"). Required for accounts tracking monetary values.
- `parentId`: The identifier of the parent account, if any (for hierarchical organization).
- `metadata`: JSON object containing additional information about the account.

The table name will be `Accounts`.

**Note on Currency:** Accounts track a single currency. For multi-currency scenarios, create separate accounts per currency.

### 3.2. AccountTransaction

The `AccountTransaction` object will have the following properties:

- `id`: A unique identifier for the transaction.
- `date`: The date the transaction occurred.
- `description`: A description of the transaction.
- `metadata`: A JSON object containing additional information about the transaction.

The table name will be `AccountTransactions`.

### 3.3. AccountTransactionEntry

The `AccountTransactionEntry` object will have the following properties:

- `id`: A unique identifier for the entry.
- `transactionId`: The identifier of the transaction this entry belongs to.
- `accountId`: The identifier of the account this entry affects.
- `amount`: The amount in the smallest currency unit (integer). For example, cents for USD/CAD, pence for GBP. Positive values represent debits, negative values represent credits.
- `currency`: ISO 4217 currency code inherited from the associated account, stored for query convenience.

The table name will be `AccountTransactionEntries`.

**Note on Amount Precision:** Using integers for the smallest currency unit (e.g., cents) avoids floating-point precision issues. For example:
- $10.50 USD = 1050 cents
- €25.99 EUR = 2599 cents
- ¥1000 JPY = 1000 yen (already integer)

## 4. Functionality

### 4.1. Account Management

The `@have/accounts` module will provide functionality for creating, retrieving, updating, and deleting accounts. It will also provide methods for traversing the account hierarchy.

### 4.2. Transaction Processing

The module will provide a simple and flexible way to record transactions and their entries. Balance enforcement is not required at the library level - applications can implement their own validation logic as needed. The focus is on CRUD operations for:

- Creating transactions with associated entries
- Retrieving transactions and their entries
- Updating transaction metadata
- Deleting transactions (and cascading entry deletions)

### 4.3. Reporting

**Deferred:** Advanced reporting features (trial balance, balance sheet, income statement) will be implemented in future iterations. Initial release focuses on CRUD operations only.

## 5. Implementation Approach

### 5.1. Phase 1: Core CRUD (Initial Release)

**Focus:** Basic data models and CRUD operations using SMRT framework decorators.

**Models to Implement:**
1. `Account` - Basic account CRUD with hierarchy support
2. `AccountTransaction` - Transaction CRUD
3. `AccountTransactionEntry` - Entry CRUD with foreign key relationships

**Collections to Implement:**
1. `AccountCollection` - Standard SMRT collection operations
2. `AccountTransactionCollection` - Standard SMRT collection operations
3. `AccountTransactionEntryCollection` - Standard SMRT collection operations

**Key Features:**
- SMRT decorators for auto-generated APIs, MCP tools, and CLI
- Multi-currency support via currency field
- Integer-based amounts for precision
- Simple parent-child account relationships
- Flexible transaction recording without balance enforcement

### 5.2. Future Phases

**Phase 2:** Query helpers and utilities
- Calculate account balances
- Filter transactions by date range
- Multi-currency conversion helpers

**Phase 3:** Reporting
- Trial balance generation
- Balance sheet generation
- Income statement generation

**Phase 4:** Advanced features
- Transaction reconciliation
- Budget tracking
- Multi-entity support

## 6. Use Case: Praeco

Praeco will use the `@have/accounts` module to track the spending of councils. For each council, a set of accounts will be created to represent their budget and expenses. When Praeco identifies a spending event in a meeting's minutes, it will create a transaction in the ledger to record the expenditure.
