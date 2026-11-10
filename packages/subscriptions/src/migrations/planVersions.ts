/**
 * Backfill effective-dated plan versions for data written before #4032.
 *
 * Run once after the manifest migration (`smrt db:migrate`) has created
 * `_smrt_subscription_plan_versions` and the `plan_version_*` columns on
 * `_smrt_tenant_subscriptions`:
 *
 * ```ts
 * const report = await migrateSubscriptionPlanVersions(db);
 * if (report.failed.length) console.error(report.failed);
 * ```
 *
 * - Every plan without versions gets version 1: its current terms, effective
 *   from the plan's `created_at`. Nothing on the plan row changes.
 * - Every subscription without a pin is pinned to the version in force at its
 *   period start (`currentPeriodStart ?? startedAt`) with
 *   `planVersionPinReason: 'migration'`. With only version 1 present that is
 *   always version 1, so no subscriber's entitlements change.
 *
 * Idempotent: plans with versions and pinned subscriptions are skipped. Runs
 * in system context across all tenants. A subscription whose existing row no
 * longer passes validation is reported in `failed` and left unpinned (it keeps
 * resolving through the live plan's version 1); the run continues.
 */
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import { snapshotLegacyPlanVersion } from '../plan-versioning.js';

export interface SubscriptionPlanVersionsMigrationReport {
  /** Plans that received their version 1. */
  plansVersioned: number;
  /** Subscriptions that received a pin. */
  subscriptionsPinned: number;
  /** Subscriptions that could not be pinned, with the validation error. */
  failed: Array<{ subscriptionId: string; error: string }>;
}

export async function migrateSubscriptionPlanVersions(
  db: DatabaseInterface,
  options: { pageSize?: number } = {},
): Promise<SubscriptionPlanVersionsMigrationReport> {
  const pageSize = options.pageSize ?? 200;
  return withSystemContext(async () => {
    const report: SubscriptionPlanVersionsMigrationReport = {
      plansVersioned: 0,
      subscriptionsPinned: 0,
      failed: [],
    };
    const plans = await SubscriptionPlanCollection.create({ db });
    for (let offset = 0; ; offset += pageSize) {
      const page = await plans.list({
        orderBy: 'id ASC',
        limit: pageSize,
        offset,
      });
      for (const plan of page) {
        if (await snapshotLegacyPlanVersion(plan)) report.plansVersioned += 1;
      }
      if (page.length < pageSize) break;
    }
    const subscriptions = await TenantSubscriptionCollection.create({ db });
    for (let offset = 0; ; offset += pageSize) {
      const page = await subscriptions.list({
        orderBy: 'id ASC',
        limit: pageSize,
        offset,
      });
      for (const subscription of page) {
        if (subscription.planVersionId || !subscription.planId) continue;
        try {
          await subscription.save();
          if (subscription.planVersionId) report.subscriptionsPinned += 1;
        } catch (error) {
          report.failed.push({
            subscriptionId: String(subscription.id),
            error: rootMessage(error),
          });
        }
      }
      if (page.length < pageSize) break;
    }
    return report;
  });
}

function rootMessage(error: unknown): string {
  let current: unknown = error;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
}
