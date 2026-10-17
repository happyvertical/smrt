import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { it } from 'vitest';
import { proveCustomerFunds } from './helpers/customer-funds-suite.js';

it('conserves customer advances with exact journals, protected mutation paths and caller rollback', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveCustomerFunds(db);
  } finally {
    disableTenancy();
    await db.close?.();
  }
});
