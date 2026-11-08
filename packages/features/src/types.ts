import type {
  SmartObjectManifest,
  SmrtClassOptions,
  SmrtObject,
} from '@happyvertical/smrt-core';

export const GLOBAL_FEATURE_SCOPE_ID = '*';

export type FeatureScopeType = 'global' | 'tenant';

/**
 * Constructor type for any `@smrt()`-decorated class that may declare feature
 * toggles. Feature targets always extend `SmrtObject`, so this mirrors
 * `@happyvertical/smrt-core`'s internal (non-exported) `SmrtObjectConstructor`
 * and remains assignable to it for `ObjectRegistry.getClassByConstructor`.
 */
export type FeatureTargetConstructor = new (
  ...args: ConstructorParameters<typeof SmrtObject>
) => SmrtObject;

export enum FeatureOverrideEffect {
  INHERIT = 'inherit',
  ENABLE = 'enable',
  DISABLE = 'disable',
}

export interface FeatureMetadata {
  [key: string]: unknown;
}

export interface FeatureDefinitionOptions {
  id?: string;
  featureKey?: string;
  packageName?: string;
  qualifiedClassName?: string;
  className?: string;
  localId?: string;
  defaultEnabled?: boolean;
  label?: string;
  description?: string;
  metadata?: FeatureMetadata | string | null;
  visibility?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface FeatureOverrideOptions {
  id?: string;
  featureKey?: string;
  scopeType?: FeatureScopeType;
  scopeId?: string;
  effect?: FeatureOverrideEffect;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface FeatureDefinitionSeed {
  featureKey: string;
  packageName: string;
  qualifiedClassName: string;
  className: string;
  localId: string;
  defaultEnabled: boolean;
  label?: string;
  description?: string;
  metadata?: FeatureMetadata;
  visibility?: string;
}

export interface SyncDefinitionsOptions {
  classNames?: string[];
  constructors?: FeatureTargetConstructor[];
  pruneStale?: boolean;
}

export interface SyncManifestOptions {
  pruneStale?: boolean;
}

export interface FeatureSyncResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  featureKeys: string[];
}

export interface FeatureResolutionContext {
  tenantId?: string;
  /**
   * Per-request plan grant source (#4761). Takes precedence over the
   * resolver's `grantSource` option and the registered global source. Build
   * it once per request (for example one `SubscriptionFeatureSource` around
   * one `SubscriptionResolver`) and pass the same object to every check.
   */
  grantSource?: FeatureGrantSource | null;
}

/**
 * Plan grants for one tenant, as reported by a {@link FeatureGrantSource}.
 * Only keys listed here are granted; every other key keeps its code default.
 * The global and tenant overrides apply on top either way.
 */
export interface FeatureGrantSnapshot {
  featureKeys: readonly string[];
  planId?: string | null;
  planKey?: string | null;
}

/**
 * The layer that last set a feature's state during resolution, low → high:
 * code default, plan grant, global override, tenant override. An `inherit`
 * override row sets nothing, so it never decides.
 */
export type FeatureDecisionLayer =
  | 'default'
  | 'plan_grant'
  | 'global_override'
  | 'tenant_override';

/** Result of `FeatureResolver.explain()`. */
export interface FeatureResolution {
  enabled: boolean;
  decidedBy: FeatureDecisionLayer;
}

/** A plan that grants a feature key, for upgrade responses. */
export interface FeatureGrantingPlan {
  planKey: string;
  planId?: string | null;
  name?: string | null;
}

/**
 * Source of plan feature grants, consulted by `FeatureResolver` between the
 * code default and the global override (#4761). `smrt-subscriptions` provides
 * `SubscriptionFeatureSource`; features never imports it, so a local install
 * with no source (or no subscription tables) simply has no grants.
 */
export interface FeatureGrantSource {
  /**
   * Grants for the tenant, or `null` when it has none (no subscription, no
   * subscription tables). Must not throw for "no subscription".
   */
  getGrants(tenantId: string): Promise<FeatureGrantSnapshot | null>;
  /**
   * Optional: the plan an upgrade response should name for `featureKey`, or
   * `null` when no visible plan grants it.
   */
  findGrantingPlan?(
    featureKey: string,
    tenantId: string | null,
  ): Promise<FeatureGrantingPlan | null>;
}

export interface FeatureTenantNode {
  id: string;
  inheritPermissions: boolean;
  cascadePermissions: boolean;
}

export interface FeatureTenantHierarchyProvider {
  getChain(tenantId: string): Promise<FeatureTenantNode[]>;
}

export type FeatureTenantHierarchyLoader = (
  options: SmrtClassOptions,
) => Promise<FeatureTenantHierarchyProvider | null>;

export interface FeatureResolverOptions {
  tenantHierarchyLoader?: FeatureTenantHierarchyLoader;
  /**
   * Grant source for this resolver instance. `null` disables grants even when
   * a global source is registered; omitted falls back to the global source
   * from `setFeatureGrantSource()`.
   */
  grantSource?: FeatureGrantSource | null;
}

/**
 * Minimal structural shape of a tenant record returned by
 * `@happyvertical/smrt-users`. Only the permission-cascade fields consumed by
 * feature resolution are modeled; everything else is left unconstrained.
 */
export interface FeatureUsersTenantRecord {
  id: string;
  inheritPermissions?: boolean;
  cascadePermissions?: boolean;
}

export interface FeatureUsersModule {
  TenantCollection: {
    create(options: SmrtClassOptions): Promise<{
      get(criteria: { id: string }): Promise<FeatureUsersTenantRecord | null>;
      getAncestorsFromRoot(
        tenantId: string,
      ): Promise<FeatureUsersTenantRecord[]>;
    }>;
  };
}

export type { SmartObjectManifest, SmrtClassOptions };
