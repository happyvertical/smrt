/**
 * Helpers for billing-cycle anchor tests (#3116), shared by the SQLite suite
 * and the PostgreSQL lane. Scenarios run at fixed future dates with no usage
 * charges, so only flat plans are billed.
 */

import type { TenantSubscription } from '@happyvertical/smrt-subscriptions';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { vi } from 'vitest';
import type { BillingRuntime } from '../../billing/runtime.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import {
  type BillingLineSource,
  BillingLineSourceCollection,
} from '../../models/billing.js';
import {
  type BillingWorld,
  NETWORK,
  PROVIDER,
  SITE,
} from './billing-fixture.js';

export const at = (iso: string) => new Date(iso);
export const DAY = 86_400_000;

export async function subscriptionOf(
  world: BillingWorld,
  tenantId: string,
): Promise<TenantSubscription> {
  const [subscription] = await withSystemContext(() =>
    world.subscriptions.list({ where: { tenantId } }),
  );
  if (!subscription) throw new Error(`No subscription for ${tenantId}`);
  return subscription;
}

export async function updateSubscription(
  world: BillingWorld,
  tenantId: string,
  patch: Partial<
    Pick<
      TenantSubscription,
      'startedAt' | 'canceledAt' | 'trialEndsAt' | 'status'
    >
  >,
): Promise<TenantSubscription> {
  const subscription = await subscriptionOf(world, tenantId);
  await withSystemContext(async () => {
    Object.assign(subscription, patch);
    await subscription.save();
  });
  return subscription;
}

/** Put SITE (billed to NETWORK) out of the way so NETWORK has nothing due. */
export async function parkNetwork(world: BillingWorld): Promise<void> {
  await updateSubscription(world, SITE, { startedAt: at('2040-01-01') });
}

/** Subscribe another tenant to the provider's site plan, billed to NETWORK. */
export async function addNetworkSite(
  world: BillingWorld,
  tenantId: string,
  startedAt: Date,
): Promise<TenantSubscription> {
  const site = await subscriptionOf(world, SITE);
  return withSystemContext(async () => {
    await world.relationships.setRelationship({
      childTenantId: tenantId,
      resellerTenantId: NETWORK,
      billingOwnerMode: 'reseller',
    });
    return world.subscriptions.create({
      tenantId,
      planId: site.planId,
      status: 'active',
      startedAt,
      externalProvider: 'smrt',
    });
  });
}

/** A payer's invoices from the provider runtime, oldest period first. */
export async function invoicesOf(
  world: BillingWorld,
  payer: string,
  runtime: BillingRuntime = world.provider,
) {
  const account = await runtime.getAccount(payer);
  if (!account) return [];
  return withTenant({ tenantId: PROVIDER }, async () =>
    (await InvoiceCollection.create({ db: runtime.db })).list({
      where: { customerId: account.customerId },
      orderBy: 'reference ASC',
    }),
  );
}

export async function flatClaims(
  world: BillingWorld,
  subscriptionId?: string,
): Promise<BillingLineSource[]> {
  const sources = await BillingLineSourceCollection.create({ db: world.db });
  const rows = await sources.list({
    where: {
      sourceType: 'subscription_period',
      ...(subscriptionId ? { lineKey: `subscription|${subscriptionId}` } : {}),
    },
  });
  return rows.sort(
    (a, b) => (a.periodStart?.getTime() ?? 0) - (b.periodStart?.getTime() ?? 0),
  );
}

/** Claimed windows as ISO pairs with amounts, in time order. */
export async function claimedWindows(
  world: BillingWorld,
  subscriptionId: string,
): Promise<Array<[string, string, number]>> {
  return (await flatClaims(world, subscriptionId)).map((claim) => [
    claim.periodStart?.toISOString() ?? '',
    claim.periodEnd?.toISOString() ?? '',
    Number(claim.amount),
  ]);
}

/** Assert that no two flat claims of one subscription cover the same time. */
export async function overlappingClaims(
  world: BillingWorld,
): Promise<string[]> {
  const bySubscription = new Map<string, BillingLineSource[]>();
  for (const claim of await flatClaims(world)) {
    const list = bySubscription.get(claim.lineKey) ?? [];
    list.push(claim);
    bySubscription.set(claim.lineKey, list);
  }
  const overlaps: string[] = [];
  for (const [key, claims] of bySubscription) {
    for (let index = 1; index < claims.length; index += 1) {
      const previous = claims[index - 1];
      const current = claims[index];
      if (
        (current.periodStart?.getTime() ?? 0) <
        (previous.periodEnd?.getTime() ?? 0)
      ) {
        overlaps.push(key);
      }
    }
  }
  return overlaps;
}

/**
 * Hold a runtime's first flat-plan claim insert for `lineKey` until
 * `release()`: `reached` resolves once the claim has read the existing
 * coverage and is about to insert, so a test can interleave a second worker
 * deterministically.
 */
export function holdFlatClaim(runtime: BillingRuntime, lineKey: string) {
  const sources = runtime.sources;
  const original = sources.create.bind(sources);
  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  let armed = true;
  const spy = vi
    .spyOn(sources, 'create')
    .mockImplementation(async (...args: Parameters<typeof sources.create>) => {
      const [data] = args;
      if (armed && (data as { lineKey?: string }).lineKey === lineKey) {
        armed = false;
        reach();
        await gate;
      }
      return original(...args);
    });
  return { reached, release, restore: () => spy.mockRestore() };
}
