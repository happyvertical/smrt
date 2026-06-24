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
  ...args: unknown[]
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

export type { SmrtClassOptions, SmartObjectManifest };
