import type {
  SmartObjectManifest,
  SmrtClassOptions,
} from '@happyvertical/smrt-core';

export const GLOBAL_FEATURE_SCOPE_ID = '*';

export type FeatureScopeType = 'global' | 'tenant';

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
  constructors?: Array<new (...args: any[]) => any>;
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

export interface FeatureUsersModule {
  TenantCollection: {
    create(options: SmrtClassOptions): Promise<{
      get(criteria: { id: string }): Promise<any>;
      getAncestorsFromRoot(tenantId: string): Promise<any[]>;
    }>;
  };
}

export type { SmrtClassOptions, SmartObjectManifest };
