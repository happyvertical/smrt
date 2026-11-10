import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { it } from 'vitest';
import { proveHistoricalCustomerFunds } from './helpers/historical-customer-funds-suite.js';

it('conserves original cash, later credit/refund audit and new explicit-account movements', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveHistoricalCustomerFunds(db);
  } finally {
    disableTenancy();
    await db.close();
  }
});

import { proveHistoricalSourceChildren } from './helpers/historical-lines-suite.js';

it('retains 1110 concrete immutable source children without invented quantities or tax allocations', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveHistoricalSourceChildren(db);
  } finally {
    disableTenancy();
    await db.close();
  }
}, 60000);
