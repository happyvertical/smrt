/**
 * Default-adapter (SQLite, in-memory) lane for the expense behaviour suite.
 * The PostgreSQL lane runs the same suite against a migrated database:
 * `expenses-postgres.optional.test.ts`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { defineExpenseSuite } from './helpers/expense-suite.js';
import { proveFinancialFactsMigration } from './helpers/financial-facts-migration.js';

describe('expenses (SQLite)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  defineExpenseSuite(() => db);
});

describe('expense financial facts SQLite migration', () => {
  it('upgrades existing rows without inventing facts and is repeatable', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    try {
      await proveFinancialFactsMigration(db, 'sqlite');
    } finally {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });
});
