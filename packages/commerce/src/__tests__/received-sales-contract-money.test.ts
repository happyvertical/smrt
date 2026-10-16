import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { it } from 'vitest';
import { proveReceivedSalesContractMoney } from './helpers/received-sales-contract-money-suite.js';

it('records exact sales agreement evidence without recognizing tax on SQLite', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveReceivedSalesContractMoney(db);
  } finally {
    disableTenancy();
    await db.close?.();
  }
});
