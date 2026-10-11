/**
 * DuckDB (in-memory) lane for the approval behaviour suite: native UUID ids
 * and TIMESTAMP columns under the same guarded transitions.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { afterAll, beforeAll, describe } from 'vitest';
import { defineApprovalSuite } from './helpers/approval-suite.js';
import { APPROVAL_CLASSES } from './helpers/classes.js';

describe('approvals (DuckDB)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: APPROVAL_CLASSES,
    });
  });

  afterAll(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  defineApprovalSuite(() => db);
});
