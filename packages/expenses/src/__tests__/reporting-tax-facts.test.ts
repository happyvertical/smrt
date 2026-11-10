import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe } from 'vitest';
import { defineReviewedTaxFactsSuite } from './helpers/reporting-tax-facts-suite.js';

describe('reporting tax facts on SQLite (#3940)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  defineReviewedTaxFactsSuite(() => db);
});
