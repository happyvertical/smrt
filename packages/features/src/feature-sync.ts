import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { SmartObjectManifest } from '@happyvertical/smrt-core/manifest';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import { listFrameworkFeatures } from './framework-features.js';
import { type FeatureHostOptions, withoutListBounds } from './list-bounds.js';
import type {
  FeatureDefinitionSeed,
  FeatureSyncResult,
  SyncDefinitionsOptions,
  SyncManifestOptions,
} from './types.js';
import {
  extractFeatureSeedsFromManifest,
  extractFeatureSeedsFromRegistryEntry,
  extractTouchedPackagesFromManifest,
  getPackageNameFromRegistry,
  type RegistryEntryLike,
} from './utils.js';

export class FeatureSyncService {
  private readonly options: FeatureHostOptions;
  private featureDefinitions!: FeatureDefinitionCollection;
  private initializationPromise: Promise<void> | null = null;

  constructor(options: FeatureHostOptions = {}) {
    this.options = options;
  }

  async syncDefinitions(
    options: SyncDefinitionsOptions = {},
  ): Promise<FeatureSyncResult> {
    await this.ensureInitialized();
    const registrations = this.collectRegistrations(options);
    const definitions = this.collectDefinitionsFromRegistrations(registrations);
    const touchedPackages =
      this.collectTouchedPackagesFromRegistrations(registrations);
    const isFilteredSync =
      Boolean(options.classNames?.length) ||
      Boolean(options.constructors?.length);
    const pruneStale = isFilteredSync ? false : (options.pruneStale ?? true);

    return this.applyDefinitions(definitions, touchedPackages, pruneStale);
  }

  async syncManifest(
    manifest: SmartObjectManifest,
    options: SyncManifestOptions = {},
  ): Promise<FeatureSyncResult> {
    await this.ensureInitialized();
    const definitions = extractFeatureSeedsFromManifest(manifest);
    const touchedPackages = extractTouchedPackagesFromManifest(manifest);
    return this.applyDefinitions(
      definitions,
      touchedPackages,
      options.pruneStale ?? true,
    );
  }

  /**
   * Mirror framework feature definitions (the standard paid keys and any
   * `defineFrameworkFeature()` registrations, #4761) into
   * `_smrt_feature_definitions` so the settings screen can list and override
   * them. Framework rows have an empty `qualifiedClassName`; this method only
   * upserts them and class syncs never prune them.
   */
  async syncFrameworkDefinitions(): Promise<FeatureSyncResult> {
    await this.ensureInitialized();
    const definitions: FeatureDefinitionSeed[] = listFrameworkFeatures().map(
      (definition) => ({
        featureKey: definition.featureKey,
        packageName: definition.packageName,
        qualifiedClassName: '',
        className: '',
        localId: definition.featureKey,
        defaultEnabled: definition.defaultEnabled,
        label: definition.label,
        description: definition.description,
        metadata: definition.metadata ? { ...definition.metadata } : undefined,
      }),
    );
    return this.applyDefinitions(definitions, new Set(), false);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        // `applyDefinitions()` enumerates the full catalog per touched package
        // to prune stale rows; a host-configured list bound must not make a
        // prune pass see a partial catalog (#3056, same hazard class as #3048).
        this.featureDefinitions = await FeatureDefinitionCollection.create(
          withoutListBounds(this.options),
        );
      })();
    }

    await this.initializationPromise;
  }

  private collectDefinitionsFromRegistrations(
    registrations: RegistryEntryLike[],
  ): FeatureDefinitionSeed[] {
    const definitions: FeatureDefinitionSeed[] = [];

    for (const registration of registrations) {
      definitions.push(...extractFeatureSeedsFromRegistryEntry(registration));
    }

    return definitions;
  }

  private collectTouchedPackagesFromRegistrations(
    registrations: RegistryEntryLike[],
  ): Set<string> {
    const packages = new Set<string>();

    for (const registration of registrations) {
      if (registration.visibility === 'test') {
        continue;
      }

      const packageName = getPackageNameFromRegistry(registration);
      if (packageName) {
        packages.add(packageName);
      }
    }

    return packages;
  }

  private collectRegistrations(
    options: SyncDefinitionsOptions,
  ): RegistryEntryLike[] {
    if (options.classNames?.length) {
      return options.classNames
        .map((name) => ObjectRegistry.getClass(name))
        .filter((value): value is NonNullable<typeof value> => !!value);
    }

    if (options.constructors?.length) {
      return options.constructors
        .map((ctor) => ObjectRegistry.getClassByConstructor(ctor))
        .filter((value): value is NonNullable<typeof value> => !!value);
    }

    const registrations: RegistryEntryLike[] = [];
    const seen = new Set<RegistryEntryLike>();

    for (const registration of ObjectRegistry.getAllClasses().values()) {
      if (seen.has(registration)) {
        continue;
      }
      seen.add(registration);
      registrations.push(registration);
    }

    return registrations;
  }

  private async applyDefinitions(
    definitions: FeatureDefinitionSeed[],
    touchedPackages: Set<string>,
    pruneStale: boolean,
  ): Promise<FeatureSyncResult> {
    const deduped = new Map<string, FeatureDefinitionSeed>();
    for (const definition of definitions) {
      deduped.set(definition.featureKey, definition);
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let deleted = 0;

    const dedupedDefinitions = Array.from(deduped.values());
    const currentKeys = new Set(
      dedupedDefinitions.map((definition) => definition.featureKey),
    );
    const upsertResults = await Promise.all(
      dedupedDefinitions.map((definition) =>
        this.featureDefinitions.upsertDefinition(definition),
      ),
    );
    for (const result of upsertResults) {
      if (result.status === 'created') created++;
      if (result.status === 'updated') updated++;
      if (result.status === 'unchanged') unchanged++;
    }

    if (pruneStale) {
      const existingByPackage = await Promise.all(
        Array.from(touchedPackages, (packageName) =>
          this.featureDefinitions.findByPackageName(packageName),
        ),
      );

      const staleDefinitions = existingByPackage.flatMap((existing) =>
        existing.filter(
          (definition) =>
            // Framework rows (no owning class) belong to
            // syncFrameworkDefinitions(), never to a class sync's prune.
            definition.qualifiedClassName !== '' &&
            !currentKeys.has(definition.featureKey),
        ),
      );

      await Promise.all(
        staleDefinitions.map((definition) => definition.delete()),
      );
      deleted = staleDefinitions.length;
    }

    return {
      total: deduped.size,
      created,
      updated,
      unchanged,
      deleted,
      featureKeys: Array.from(currentKeys).sort(),
    };
  }
}
