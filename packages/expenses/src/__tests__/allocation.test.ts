import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterEach, beforeEach, describe } from 'vitest';
import { defineAllocationSuite } from './helpers/allocation-suite.js';

describe('allocations (SQLite)', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });
  afterEach(async () => {
    await (db as { close?: () => Promise<void> } | undefined)?.close?.();
  });
  defineAllocationSuite(() => db);
});
