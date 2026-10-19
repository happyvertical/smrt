import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, it } from 'vitest';
import {
  assertDelegatedGuardianReview,
  assertIngestionBridge,
  ingestionClasses,
} from './ingestion-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
it('real receipt/capture retry and transaction-bound grade rollback, then correction', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ingestionClasses,
  });
  try {
    await assertIngestionBridge(db);
  } finally {
    await db.close?.();
  }
});

it('learner upload is reviewed by guardian through stable delegated execution', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ingestionClasses,
  });
  try {
    await assertDelegatedGuardianReview(db);
  } finally {
    await db.close?.();
  }
});
