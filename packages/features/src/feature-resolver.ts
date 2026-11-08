import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { importWorkspaceModule } from '@happyvertical/smrt-core/utils/import-workspace-module';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import { getFeatureGrantSource } from './feature-grants.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import {
  getFrameworkFeature,
  isFrameworkFeatureKey,
} from './framework-features.js';
import { type FeatureHostOptions, withoutListBounds } from './list-bounds.js';
import {
  type FeatureGrantingPlan,
  type FeatureGrantSource,
  FeatureOverrideEffect,
  type FeatureResolution,
  type FeatureResolutionContext,
  type FeatureResolverOptions,
  type FeatureTargetConstructor,
  type FeatureTenantHierarchyProvider,
  type FeatureTenantNode,
  type FeatureUsersModule,
} from './types.js';
import {
  findFeatureDefaultInRegistry,
  resolveFeatureKeyForTarget,
} from './utils.js';

export class FeatureResolver {
  private readonly options: FeatureHostOptions;
  private readonly resolverOptions: FeatureResolverOptions;
  private featureDefinitions!: FeatureDefinitionCollection;
  private featureOverrides!: FeatureOverrideCollection;
  private initializationPromise: Promise<void> | null = null;
  private tenantHierarchyPromise: Promise<FeatureTenantHierarchyProvider | null> | null =
    null;

  constructor(
    options: FeatureHostOptions = {},
    resolverOptions: FeatureResolverOptions = {},
  ) {
    this.options = options;
    this.resolverOptions = resolverOptions;
  }

  async isEnabled(
    featureKey: string,
    context: FeatureResolutionContext = {},
  ): Promise<boolean> {
    return (await this.explain(featureKey, context)).enabled;
  }

  /**
   * Resolve `featureKey` and report which layer decided the result: the code
   * default, a plan grant, the global override, or a tenant override.
   *
   * Layers apply low → high: code default, plan grant (a granted key becomes
   * enabled), global override, tenant ancestor chain, the tenant's own
   * override. The global override sits above plan grants because it is an
   * explicit operator act: a global DISABLE stops the feature fleet-wide,
   * granted tenants included. Tenant overrides still win over everything.
   * Without a tenant context only the default and the global override apply.
   */
  async explain(
    featureKey: string,
    context: FeatureResolutionContext = {},
  ): Promise<FeatureResolution> {
    await this.ensureInitialized();

    const defaultState: FeatureResolution = {
      enabled: await this.resolveBaseState(featureKey),
      decidedBy: 'default',
    };
    const globalOverride =
      await this.featureOverrides.getGlobalOverride(featureKey);

    if (!context.tenantId) {
      return this.applyOverride(
        defaultState,
        globalOverride?.effect,
        'global_override',
      );
    }

    // Plan grants (#4761) sit below the global override: a granted key starts
    // enabled, then the global override applies on top of it.
    const grantedState: FeatureResolution = (await this.isGranted(
      featureKey,
      context,
    ))
      ? { enabled: true, decidedBy: 'plan_grant' }
      : defaultState;
    // The state every tenant walk starts from, and the one a non-inheriting
    // tenant resets to.
    const postGlobalState = this.applyOverride(
      grantedState,
      globalOverride?.effect,
      'global_override',
    );

    const tenantHierarchy = await this.getTenantHierarchy();
    if (!tenantHierarchy) {
      const directOverride = await this.featureOverrides.getTenantOverride(
        featureKey,
        context.tenantId,
      );
      return this.applyOverride(
        postGlobalState,
        directOverride?.effect,
        'tenant_override',
      );
    }

    const chain = await tenantHierarchy.getChain(context.tenantId);
    if (chain.length === 0) {
      const directOverride = await this.featureOverrides.getTenantOverride(
        featureKey,
        context.tenantId,
      );
      return this.applyOverride(
        postGlobalState,
        directOverride?.effect,
        'tenant_override',
      );
    }

    const overrides = await this.featureOverrides.getOverrideMap(
      featureKey,
      'tenant',
      chain.map((node) => node.id),
    );

    let inheritedState = postGlobalState;

    for (let index = 0; index < chain.length; index++) {
      const current = chain[index];
      const previous = index > 0 ? chain[index - 1] : null;
      const shouldInherit =
        index === 0 ||
        (!!previous?.cascadePermissions && current.inheritPermissions);

      const baseline = shouldInherit ? inheritedState : postGlobalState;
      const override = overrides.get(current.id);
      inheritedState = this.applyOverride(
        baseline,
        override?.effect,
        'tenant_override',
      );
    }

    return inheritedState;
  }

  async isEnabledFor(
    classOrInstance: object | FeatureTargetConstructor,
    localId: string,
    context: FeatureResolutionContext = {},
  ): Promise<boolean> {
    const { featureKey } = resolveFeatureKeyForTarget(classOrInstance, localId);
    return this.isEnabled(featureKey, context);
  }

  /**
   * The plan that grants `featureKey`, for an upgrade response; `null` when
   * no grant source is available or no visible plan grants it.
   */
  async findGrantingPlan(
    featureKey: string,
    context: FeatureResolutionContext = {},
  ): Promise<FeatureGrantingPlan | null> {
    const source = this.grantSourceFor(context);
    if (!source?.findGrantingPlan) {
      return null;
    }
    return source.findGrantingPlan(featureKey, context.tenantId ?? null);
  }

  private grantSourceFor(
    context: FeatureResolutionContext,
  ): FeatureGrantSource | null {
    if (context.grantSource !== undefined) {
      return context.grantSource;
    }
    if (this.resolverOptions.grantSource !== undefined) {
      return this.resolverOptions.grantSource;
    }
    return getFeatureGrantSource() ?? null;
  }

  private async isGranted(
    featureKey: string,
    context: FeatureResolutionContext,
  ): Promise<boolean> {
    const source = this.grantSourceFor(context);
    if (!source || !context.tenantId) {
      return false;
    }
    const grants = await source.getGrants(context.tenantId);
    return grants?.featureKeys.includes(featureKey) ?? false;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        // A host-configured `defaultListLimit`/`maxListLimit` must never reach
        // these reads: `getOverrideMap()` walks the tenant ancestor chain, and
        // a dropped ancestor override would change the flag's resolved value
        // silently (#3056, same hazard class as #3048).
        const options = withoutListBounds(this.options);
        this.featureDefinitions =
          await FeatureDefinitionCollection.create(options);
        this.featureOverrides = await FeatureOverrideCollection.create(options);
      })();
    }

    await this.initializationPromise;
  }

  private async resolveBaseState(featureKey: string): Promise<boolean> {
    const frameworkFeature = getFrameworkFeature(featureKey);
    if (frameworkFeature) {
      return frameworkFeature.defaultEnabled;
    }

    // A framework (dotted) key registered in another process may still have
    // a synced definition; it has no class to look up in the registry.
    const registryDefault = isFrameworkFeatureKey(featureKey)
      ? undefined
      : findFeatureDefaultInRegistry(featureKey);
    if (registryDefault !== undefined) {
      return registryDefault;
    }

    const definition =
      await this.featureDefinitions.findByFeatureKey(featureKey);
    if (!definition) {
      throw new Error(
        `Feature "${featureKey}" is not declared in the registry or synced feature definitions.`,
      );
    }

    return definition.defaultEnabled;
  }

  private applyOverride(
    current: FeatureResolution,
    effect: FeatureOverrideEffect | undefined,
    layer: FeatureResolution['decidedBy'],
  ): FeatureResolution {
    switch (effect) {
      case FeatureOverrideEffect.ENABLE:
        return { enabled: true, decidedBy: layer };
      case FeatureOverrideEffect.DISABLE:
        return { enabled: false, decidedBy: layer };
      default:
        return current;
    }
  }

  private async getTenantHierarchy(): Promise<FeatureTenantHierarchyProvider | null> {
    if (!this.tenantHierarchyPromise) {
      const loader =
        this.resolverOptions.tenantHierarchyLoader ||
        defaultTenantHierarchyLoader;
      this.tenantHierarchyPromise = loader(this.options);
    }

    return this.tenantHierarchyPromise;
  }
}

async function defaultTenantHierarchyLoader(
  options: SmrtClassOptions,
): Promise<FeatureTenantHierarchyProvider | null> {
  try {
    const usersModule = await importWorkspaceModule<FeatureUsersModule>({
      packageName: '@happyvertical/smrt-users',
      sourceEntry: 'packages/users/src/collections/index.ts',
      purpose: 'tenant-aware feature flag resolution',
    });

    const tenantCollection = await usersModule.TenantCollection.create(options);
    return {
      async getChain(tenantId: string): Promise<FeatureTenantNode[]> {
        const tenant = await tenantCollection.get({ id: tenantId });
        if (!tenant) {
          return [];
        }

        const ancestors = await tenantCollection.getAncestorsFromRoot(tenantId);
        return [...ancestors, tenant].map((node) => ({
          id: String(node.id),
          inheritPermissions: Boolean(node.inheritPermissions),
          cascadePermissions: Boolean(node.cascadePermissions),
        }));
      },
    };
  } catch (error) {
    if (isMissingUsersDependency(error)) {
      return null;
    }
    throw error;
  }
}

function isMissingUsersDependency(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const causeMessage =
    error.cause instanceof Error ? ` ${error.cause.message}` : '';
  const text = `${error.message}${causeMessage}`;

  return (
    text.includes('@happyvertical/smrt-users') &&
    (text.includes('Cannot find module') ||
      text.includes('Failed to load') ||
      text.includes('could not find'))
  );
}
