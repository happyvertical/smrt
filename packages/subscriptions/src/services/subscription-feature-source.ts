/**
 * Plan feature grants as `smrt-features` flags (#4761).
 *
 * `SubscriptionFeatureSource` implements `smrt-features`' `FeatureGrantSource`
 * structurally, so this package does not depend on `smrt-features` and
 * `smrt-features` never depends on this one. Hosts either pass a per-request
 * source as `grantSource` in the feature resolution context, or register an
 * app-wide one with {@link registerSubscriptionFeatureSource}, which writes the
 * `Symbol.for('@happyvertical/smrt-features:grant-source')` slot that
 * `FeatureResolver` reads.
 *
 * Local installs: when the subscription tables do not exist, or the tenant has
 * no entitled subscription, the source reports no grants and logs nothing, so
 * paid keys stay at their (off) defaults. Every other failure propagates: a
 * database outage must not silently look like "no plan".
 */
import {
  classifyDatabaseError,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { SubscriptionResolver } from './subscription-resolver.js';

/** Structural mirror of `smrt-features`' `FeatureGrantSnapshot`. */
export interface SubscriptionFeatureGrants {
  featureKeys: readonly string[];
  planId: string | null;
  planKey: string | null;
}

/** Structural mirror of `smrt-features`' `FeatureGrantingPlan`. */
export interface SubscriptionGrantingPlan {
  planKey: string;
  planId: string | null;
  name: string | null;
}

/** Reader for the plan catalog an upgrade response searches. */
export interface GrantingPlanReader {
  findActive(): Promise<SubscriptionPlan[]>;
}

export interface SubscriptionFeatureSourceOptions {
  /** One resolver for the request (or app lifetime); never built per flag. */
  resolver: SubscriptionResolver;
  /** Plan catalog for `findGrantingPlan()`; omitted means no plan is named. */
  plans?: GrantingPlanReader;
  /**
   * Memoize grants per tenant for this instance's lifetime (default `true`).
   * Keep it on for a request-scoped source; a process-wide source registered
   * with {@link registerSubscriptionFeatureSource} turns it off so a plan
   * change is visible on the next check.
   */
  memoize?: boolean;
  /** Clock for entitlement checks; defaults to the current time. */
  now?: () => Date;
}

/** `Symbol.for()` key `smrt-features` reads its global grant source from. */
export const FEATURE_GRANT_SOURCE_SLOT_KEY =
  '@happyvertical/smrt-features:grant-source';

const SUBSCRIPTION_TABLES = new Set([
  '_smrt_tenant_subscriptions',
  '_smrt_subscription_plans',
  '_smrt_subscription_plan_versions',
]);

export class SubscriptionFeatureSource {
  private readonly resolver: SubscriptionResolver;
  private readonly plans: GrantingPlanReader | undefined;
  private readonly memoize: boolean;
  private readonly now: () => Date;
  private readonly grants = new Map<
    string,
    Promise<SubscriptionFeatureGrants | null>
  >();
  private catalog: Promise<SubscriptionPlan[] | null> | null = null;

  constructor(options: SubscriptionFeatureSourceOptions) {
    this.resolver = options.resolver;
    this.plans = options.plans;
    this.memoize = options.memoize ?? true;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Build one source with its own resolver and plan catalog. Call once per
   * request (or once at setup with `memoize: false` for a global source).
   */
  static async create(
    classOptions: SmrtClassOptions = {},
    options: Omit<SubscriptionFeatureSourceOptions, 'resolver' | 'plans'> = {},
  ): Promise<SubscriptionFeatureSource> {
    const [resolver, plans] = await Promise.all([
      SubscriptionResolver.create(classOptions),
      SubscriptionPlanCollection.create(classOptions),
    ]);
    return new SubscriptionFeatureSource({ ...options, resolver, plans });
  }

  /** Feature keys the tenant's entitled plan grants, or `null` for none. */
  getGrants(tenantId: string): Promise<SubscriptionFeatureGrants | null> {
    if (!this.memoize) {
      return this.loadGrants(tenantId);
    }
    let pending = this.grants.get(tenantId);
    if (!pending) {
      pending = this.loadGrants(tenantId);
      this.grants.set(tenantId, pending);
      // A failed lookup is not cached; the next check retries.
      pending.catch(() => this.grants.delete(tenantId));
    }
    return pending;
  }

  /**
   * The first active plan (by `sortOrder`) visible in the current context
   * that grants `featureKey`, for an upgrade response.
   */
  async findGrantingPlan(
    featureKey: string,
    _tenantId: string | null,
  ): Promise<SubscriptionGrantingPlan | null> {
    const catalog = await this.loadCatalog();
    const plan = catalog?.find((candidate) =>
      candidate.getFeatureKeys().includes(featureKey),
    );
    if (!plan) {
      return null;
    }
    return {
      planKey: plan.planKey,
      planId: plan.id ? String(plan.id) : null,
      name: plan.name || null,
    };
  }

  private async loadGrants(
    tenantId: string,
  ): Promise<SubscriptionFeatureGrants | null> {
    try {
      const grants = await this.resolver.resolveFeatureGrants(
        { kind: 'tenant', tenantId },
        { now: this.now() },
      );
      return grants.featureKeys.length > 0
        ? {
            featureKeys: grants.featureKeys,
            planId: grants.planId,
            planKey: grants.planKey,
          }
        : null;
    } catch (error) {
      if (isMissingSubscriptionTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  private loadCatalog(): Promise<SubscriptionPlan[] | null> {
    if (!this.plans) {
      return Promise.resolve(null);
    }
    const load = async () => {
      try {
        return (await this.plans?.findActive()) ?? null;
      } catch (error) {
        if (isMissingSubscriptionTableError(error)) {
          return null;
        }
        throw error;
      }
    };
    if (!this.memoize) {
      return load();
    }
    if (!this.catalog) {
      this.catalog = load();
      this.catalog.catch(() => {
        this.catalog = null;
      });
    }
    return this.catalog;
  }
}

/**
 * Register `source` as `smrt-features`' process-wide grant source, or clear it
 * with `undefined`. Equivalent to `setFeatureGrantSource()` from
 * `smrt-features`, without importing that package. Register a source built
 * with `memoize: false`; pass request-scoped sources per call instead.
 */
export function registerSubscriptionFeatureSource(
  source: SubscriptionFeatureSource | undefined,
): void {
  (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for(FEATURE_GRANT_SOURCE_SLOT_KEY)
  ] = source;
}

/**
 * True when `error` reports that one of this package's tables does not exist
 * — core's `DB_SCHEMA_MISSING` or a raw "no such table" / "relation does not
 * exist" driver error naming a subscription table.
 */
export function isMissingSubscriptionTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const candidate = current as {
      code?: unknown;
      details?: { tableName?: unknown };
      cause?: unknown;
    };
    if (
      candidate.code === 'DB_SCHEMA_MISSING' &&
      typeof candidate.details?.tableName === 'string' &&
      SUBSCRIPTION_TABLES.has(candidate.details.tableName)
    ) {
      return true;
    }
    current = candidate.cause;
  }

  const classification = classifyDatabaseError(error);
  if (classification.kind !== 'undefined_object') {
    return false;
  }
  if (classification.driverCodes.includes('42703')) {
    // Undefined column: schema drift, not a missing table.
    return false;
  }
  return classification.driverMessages.some((message) => {
    const lower = message.toLowerCase();
    return (
      (lower.includes('no such table') || lower.includes('does not exist')) &&
      Array.from(SUBSCRIPTION_TABLES).some((table) => lower.includes(table))
    );
  });
}
