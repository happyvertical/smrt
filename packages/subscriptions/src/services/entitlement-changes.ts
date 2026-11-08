/**
 * Entitlement change hook (#4759).
 *
 * A plan change arrives through the host's billing webhook (Stripe in
 * smrt-saas-starter, #4667): the host writes the new `TenantSubscription`
 * state. Code that must react to a feature key being gained or lost (hosted
 * inference provisioning, #4759) registers a listener here; the host wraps
 * its webhook write in {@link trackEntitlementChange}, which snapshots the
 * tenant's feature grants before and after and notifies listeners with the
 * difference.
 *
 * Listeners run after the write has been applied (and committed, when the
 * host's write commits inside `apply`). A listener failure never undoes the
 * write: it is collected in the outcome's `failures` so the host can log it,
 * alert, or retry the reaction (listeners are expected to be idempotent;
 * hosted provisioning is, through `runOnce()`). This package stays free of
 * any listener's dependencies: listeners satisfy the structural
 * {@link EntitlementChangeListener} type.
 */
import type { PlanFeatureGrant } from '../types.js';
import { isMissingSubscriptionTableError } from './subscription-feature-source.js';
import type { SubscriptionResolver } from './subscription-resolver.js';

/** A tenant's entitled grants at one moment. */
export interface EntitlementSnapshot {
  planId: string | null;
  planKey: string | null;
  /** Enabled feature keys, sorted. */
  featureKeys: string[];
  /** Enabled grants (with their `metadata`), sorted by key. */
  grants: PlanFeatureGrant[];
}

/** The difference between two snapshots of one tenant. */
export interface EntitlementChange {
  tenantId: string;
  /** Keys granted after but not before. */
  gained: string[];
  /** Keys granted before but not after. */
  lost: string[];
  /**
   * Keys granted both before and after whose grant `metadata` changed (a
   * plan's budget for `inference.hosted`, for instance).
   */
  changed: string[];
  before: EntitlementSnapshot;
  after: EntitlementSnapshot;
}

/** Reacts to an {@link EntitlementChange}; may be async. */
export type EntitlementChangeListener = (
  change: EntitlementChange,
) => void | Promise<void>;

/** One listener that threw. */
export interface EntitlementChangeFailure {
  error: unknown;
}

/** What {@link notifyEntitlementChange} reports. */
export interface EntitlementChangeOutcome {
  change: EntitlementChange;
  /** Listeners that threw, in registration order. Empty when all succeeded. */
  failures: EntitlementChangeFailure[];
}

/** `Symbol.for()` key of the process-wide listener set. */
export const ENTITLEMENT_CHANGE_LISTENERS_SLOT_KEY =
  '@happyvertical/smrt-subscriptions:entitlement-change-listeners';

function listenerSet(): Set<EntitlementChangeListener> {
  const slot = globalThis as unknown as Record<symbol, unknown>;
  const key = Symbol.for(ENTITLEMENT_CHANGE_LISTENERS_SLOT_KEY);
  let set = slot[key] as Set<EntitlementChangeListener> | undefined;
  if (!set) {
    set = new Set();
    slot[key] = set;
  }
  return set;
}

/**
 * Register a process-wide listener. Returns a function that unregisters it.
 * Registering the same function twice keeps one registration.
 */
export function registerEntitlementChangeListener(
  listener: EntitlementChangeListener,
): () => void {
  const set = listenerSet();
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** The registered listeners, in registration order. */
export function getEntitlementChangeListeners(): EntitlementChangeListener[] {
  return [...listenerSet()];
}

/** An empty snapshot: no entitled subscription. */
export function emptyEntitlementSnapshot(): EntitlementSnapshot {
  return { planId: null, planKey: null, featureKeys: [], grants: [] };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Snapshot the tenant's entitled grants through `resolver` (no usage
 * meters are read). Missing subscription tables read as no plan, like
 * `SubscriptionFeatureSource`; every other error propagates.
 */
export async function snapshotEntitlements(
  resolver: Pick<SubscriptionResolver, 'resolveFeatureGrants'>,
  tenantId: string,
  options: { now?: Date } = {},
): Promise<EntitlementSnapshot> {
  try {
    const resolved = await resolver.resolveFeatureGrants(
      { kind: 'tenant', tenantId },
      options.now ? { now: options.now } : {},
    );
    const grants = (resolved.grants ?? [])
      .filter((grant) => grant.enabled !== false)
      .sort((a, b) => a.featureKey.localeCompare(b.featureKey));
    return {
      planId: resolved.planId,
      planKey: resolved.planKey,
      featureKeys: [...new Set(resolved.featureKeys)].sort(),
      grants,
    };
  } catch (error) {
    if (isMissingSubscriptionTableError(error)) {
      return emptyEntitlementSnapshot();
    }
    throw error;
  }
}

/** Compute the {@link EntitlementChange} between two snapshots. */
export function diffEntitlements(
  tenantId: string,
  before: EntitlementSnapshot,
  after: EntitlementSnapshot,
): EntitlementChange {
  const was = new Set(before.featureKeys);
  const now = new Set(after.featureKeys);
  const metadataOf = (snapshot: EntitlementSnapshot, key: string) =>
    canonicalJson(
      snapshot.grants.find((grant) => grant.featureKey === key)?.metadata ??
        null,
    );
  return {
    tenantId,
    gained: after.featureKeys.filter((key) => !was.has(key)),
    lost: before.featureKeys.filter((key) => !now.has(key)),
    changed: after.featureKeys.filter(
      (key) =>
        was.has(key) && metadataOf(before, key) !== metadataOf(after, key),
    ),
    before,
    after,
  };
}

/** True when the change gains, loses or changes at least one key. */
export function hasEntitlementChange(change: EntitlementChange): boolean {
  return (
    change.gained.length > 0 ||
    change.lost.length > 0 ||
    change.changed.length > 0
  );
}

/**
 * Notify `listeners` (default: the registered ones) of `change`, one after
 * another. A change with nothing gained, lost or changed notifies nobody.
 * Never throws for a listener: failures are returned.
 */
export async function notifyEntitlementChange(
  change: EntitlementChange,
  options: { listeners?: readonly EntitlementChangeListener[] } = {},
): Promise<EntitlementChangeOutcome> {
  const failures: EntitlementChangeFailure[] = [];
  if (!hasEntitlementChange(change)) return { change, failures };
  for (const listener of options.listeners ?? getEntitlementChangeListeners()) {
    try {
      await listener(change);
    } catch (error) {
      failures.push({ error });
    }
  }
  return { change, failures };
}

/** Options for {@link trackEntitlementChange}. */
export interface TrackEntitlementChangeOptions {
  tenantId: string;
  /** Resolver used for both snapshots (build one per webhook delivery). */
  resolver: Pick<SubscriptionResolver, 'resolveFeatureGrants'>;
  /** Listeners to notify instead of the registered ones. */
  listeners?: readonly EntitlementChangeListener[];
  /** Clock for both snapshots; defaults to the current time at each. */
  now?: () => Date;
}

/**
 * Snapshot the tenant's grants, run `apply` (the webhook's subscription
 * write), snapshot again, and notify listeners of the difference. `apply`'s
 * error propagates and notifies nobody. Listener failures are returned in
 * `failures`, never thrown.
 *
 * ```ts
 * const { failures } = await trackEntitlementChange(
 *   { tenantId, resolver: await SubscriptionResolver.create({ db }) },
 *   () => applyStripeSubscriptionUpdate(event),
 * );
 * ```
 */
export async function trackEntitlementChange<T>(
  options: TrackEntitlementChangeOptions,
  apply: () => Promise<T>,
): Promise<EntitlementChangeOutcome & { result: T }> {
  const at = () => (options.now ? { now: options.now() } : {});
  const before = await snapshotEntitlements(
    options.resolver,
    options.tenantId,
    at(),
  );
  const result = await apply();
  const after = await snapshotEntitlements(
    options.resolver,
    options.tenantId,
    at(),
  );
  const outcome = await notifyEntitlementChange(
    diffEntitlements(options.tenantId, before, after),
    options.listeners ? { listeners: options.listeners } : {},
  );
  return { ...outcome, result };
}
