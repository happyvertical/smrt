import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { describe, expect, it, vi } from 'vitest';
import { runPlanVersionScenario } from './helpers/plan-version-scenario.js';

const { getDatabase } =
  await vi.importActual<typeof import('@happyvertical/sql')>(
    '@happyvertical/sql',
  );

describe('effective-dated plan versions on PostgreSQL (#4032)', () => {
  it.skipIf(!isPostgresAvailable())(
    'preserves paid-period entitlements across amendment, renewal, cancellation, tenant key reuse and migration',
    async () => {
      const baseUrl = process.env.DATABASE_URL;
      if (!baseUrl) throw new Error('DATABASE_URL required');
      const admin = await getDatabase({ type: 'postgres', url: baseUrl });
      const databaseName = `plan_versions_4032_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      const db = await getDatabase({ type: 'postgres', url: url.toString() });
      try {
        await getTestDatabase({
          db,
          classes: [
            'SubscriptionPlan',
            'SubscriptionPlanVersion',
            'TenantSubscription',
            'TenantUsageMetric',
          ],
        });
        // Version money is integer minor units and pins are native UUIDs.
        const columns = await db.query(
          `SELECT table_name, column_name, data_type FROM information_schema.columns
           WHERE (table_name = '_smrt_subscription_plan_versions'
                  AND column_name IN ('price_amount', 'minimum_amount', 'suggested_amount', 'plan_id', 'id'))
              OR (table_name = '_smrt_tenant_subscriptions' AND column_name = 'plan_version_id')`,
        );
        const types = Object.fromEntries(
          (
            columns.rows as {
              table_name: string;
              column_name: string;
              data_type: string;
            }[]
          ).map((row) => [
            `${row.table_name}.${row.column_name}`,
            row.data_type,
          ]),
        );
        expect(types).toEqual({
          '_smrt_subscription_plan_versions.id': 'uuid',
          '_smrt_subscription_plan_versions.plan_id': 'uuid',
          '_smrt_subscription_plan_versions.price_amount': 'bigint',
          '_smrt_subscription_plan_versions.minimum_amount': 'bigint',
          '_smrt_subscription_plan_versions.suggested_amount': 'bigint',
          '_smrt_tenant_subscriptions.plan_version_id': 'uuid',
        });
        await runPlanVersionScenario(db);
      } finally {
        await db.close?.();
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        await admin.close?.();
      }
    },
  );
});
