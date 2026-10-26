import { getDatabase } from '@happyvertical/sql';
import { afterAll, describe } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap.js';
import { externalAgentUsageSuite } from './external-agent-usage.cases.js';

const url = process.env.SMRT_TEST_POSTGRES_URL;
if (url) {
  const db = await getDatabase({ type: 'postgres', url });
  await ensureSystemTables(db);
  const fixtureTenantId = `external-agent-fixture-${crypto.randomUUID()}`;
  externalAgentUsageSuite('postgres', async () => db, fixtureTenantId);
  afterAll(async () => {
    await db.query(
      'DELETE FROM _smrt_ai_usage WHERE tenant_id = ?',
      fixtureTenantId,
    );
    await db.close?.();
  });
} else {
  describe.skip('external agent usage PostgreSQL (SMRT_TEST_POSTGRES_URL required)', () => {});
}
