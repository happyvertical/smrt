import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { it } from 'vitest';
import { proveRetentionAccounting } from './helpers/retention-accounting-suite.js';

it('reconciles provider retention, partial failures, release and credit on SQLite', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveRetentionAccounting(db);
  } finally {
    disableTenancy();
    await db.close?.();
  }
});
