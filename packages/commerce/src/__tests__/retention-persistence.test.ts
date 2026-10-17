import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { it } from 'vitest';
import { proveRetention } from './helpers/retention-suite.js';

it('preserves retained settlement, release, credits and rollback on SQLite', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  enableTenancy();
  try {
    await proveRetention(db);
  } finally {
    disableTenancy();
    await db.close?.();
  }
});
