import type { DatabaseInterface } from '@happyvertical/sql';

/** Run after manifest migration installs the tenant-scoped natural key. */
export async function dropLegacyPlanKeyIndex(
  db: DatabaseInterface,
): Promise<void> {
  await db.query(
    'DROP INDEX IF EXISTS "_smrt_subscription_plans_plan_key_idx"',
  );
}
