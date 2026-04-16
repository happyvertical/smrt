import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { importWorkspaceModule } from '@happyvertical/smrt-core/utils/import-workspace-module';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import {
  FeatureOverrideEffect,
  type FeatureResolutionContext,
  type FeatureResolverOptions,
  type FeatureTenantHierarchyProvider,
  type FeatureTenantNode,
  type FeatureUsersModule,
} from './types.js';
import {
  findFeatureDefaultInRegistry,
  resolveFeatureKeyForTarget,
} from './utils.js';

export class FeatureResolver {
  private readonly options: SmrtClassOptions;
  private readonly resolverOptions: FeatureResolverOptions;
  private featureDefinitions!: FeatureDefinitionCollection;
  private featureOverrides!: FeatureOverrideCollection;
  private initializationPromise: Promise<void> | null = null;
  private tenantHierarchyPromise: Promise<FeatureTenantHierarchyProvider | null> | null =
    null;

  constructor(
    options: SmrtClassOptions = {},
    resolverOptions: FeatureResolverOptions = {},
  ) {
    this.options = options;
    this.resolverOptions = resolverOptions;
  }

  async isEnabled(
    featureKey: string,
    context: FeatureResolutionContext = {},
  ): Promise<boolean> {
    await this.ensureInitialized();

    const baseState = await this.resolveBaseState(featureKey);
    const globalOverride =
      await this.featureOverrides.getGlobalOverride(featureKey);
    const globalState = this.applyOverride(baseState, globalOverride?.effect);

    if (!context.tenantId) {
      return globalState;
    }

    const tenantHierarchy = await this.getTenantHierarchy();
    if (!tenantHierarchy) {
      const directOverride = await this.featureOverrides.getTenantOverride(
        featureKey,
        context.tenantId,
      );
      return this.applyOverride(globalState, directOverride?.effect);
    }

    const chain = await tenantHierarchy.getChain(context.tenantId);
    if (chain.length === 0) {
      const directOverride = await this.featureOverrides.getTenantOverride(
        featureKey,
        context.tenantId,
      );
      return this.applyOverride(globalState, directOverride?.effect);
    }

    const overrides = await this.featureOverrides.getOverrideMap(
      featureKey,
      'tenant',
      chain.map((node) => node.id),
    );

    let inheritedState = globalState;

    for (let index = 0; index < chain.length; index++) {
      const current = chain[index];
      const previous = index > 0 ? chain[index - 1] : null;
      const shouldInherit =
        index === 0 ||
        (!!previous?.cascadePermissions && current.inheritPermissions);

      const baseline = shouldInherit ? inheritedState : globalState;
      const override = overrides.get(current.id);
      inheritedState = this.applyOverride(baseline, override?.effect);
    }

    return inheritedState;
  }

  async isEnabledFor(
    classOrInstance: object | (new (...args: any[]) => any),
    localId: string,
    context: FeatureResolutionContext = {},
  ): Promise<boolean> {
    const { featureKey } = resolveFeatureKeyForTarget(classOrInstance, localId);
    return this.isEnabled(featureKey, context);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        this.featureDefinitions = await (
          FeatureDefinitionCollection as any
        ).create(this.options);
        this.featureOverrides = await (FeatureOverrideCollection as any).create(
          this.options,
        );
      })();
    }

    await this.initializationPromise;
  }

  private async resolveBaseState(featureKey: string): Promise<boolean> {
    const registryDefault = findFeatureDefaultInRegistry(featureKey);
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
    currentState: boolean,
    effect: FeatureOverrideEffect | undefined,
  ): boolean {
    switch (effect) {
      case FeatureOverrideEffect.ENABLE:
        return true;
      case FeatureOverrideEffect.DISABLE:
        return false;
      default:
        return currentState;
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
        return [...ancestors, tenant].map((node: any) => ({
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
