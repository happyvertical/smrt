import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { it } from 'vitest';
import { proveOrdinaryAccounting } from './helpers/ordinary-accounting-suite.js';

it('reconciles ordinary provider credit/refund coordination on SQLite', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveOrdinaryAccounting(db);
  } finally {
    disableTenancy();
    await db.close?.();
  }
});
