import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterEach, beforeEach, describe } from 'vitest';
import { defineSupplierPayableSuite } from './helpers/supplier-payable-suite.js';

describe('Expense supplier payable authority (SQLite)', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });
  defineSupplierPayableSuite(() => db);
});
