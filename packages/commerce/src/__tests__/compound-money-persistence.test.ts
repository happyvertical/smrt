import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { it } from 'vitest';
import { proveCompoundMoney } from './helpers/compound-money-suite.js';

it('preserves compound frozen bases, partial/final credits and reports on SQLite', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveCompoundMoney(db);
  } finally {
    disableTenancy();
    await db.close?.();
  }
});
