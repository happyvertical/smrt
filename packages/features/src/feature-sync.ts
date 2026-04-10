import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import type { SmartObjectManifest } from '@happyvertical/smrt-core/manifest';
import { FeatureDefinitionCollection } from './feature-definitions.js';
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
} from './utils.js';

export class FeatureSyncService {
  private readonly options: SmrtClassOptions;
  private featureDefinitions!: FeatureDefinitionCollection;
  private initializationPromise: Promise<void> | null = null;

  constructor(options: SmrtClassOptions = {}) {
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
    return this.applyDefinitions(
      definitions,
      touchedPackages,
      options.pruneStale ?? !isFilteredSync,
    );
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

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        this.featureDefinitions = await (
          FeatureDefinitionCollection as any
        ).create(this.options);
      })();
    }

    await this.initializationPromise;
  }

  private collectDefinitionsFromRegistrations(
    registrations: Array<any>,
  ): FeatureDefinitionSeed[] {
    const definitions: FeatureDefinitionSeed[] = [];

    for (const registration of registrations) {
      definitions.push(...extractFeatureSeedsFromRegistryEntry(registration));
    }

    return definitions;
  }

  private collectTouchedPackagesFromRegistrations(
    registrations: Array<any>,
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

  private collectRegistrations(options: SyncDefinitionsOptions): Array<any> {
    if (options.classNames?.length) {
      return options.classNames
        .map((name) => ObjectRegistry.getClass(name))
        .filter((value): value is NonNullable<typeof value> => !!value);
    }

    if (options.constructors?.length) {
      return options.constructors
        .map((ctor) => ObjectRegistry.getClassByConstructor(ctor as any))
        .filter((value): value is NonNullable<typeof value> => !!value);
    }

    const registrations: any[] = [];
    const seen = new Set<any>();

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

    const currentKeys = new Set<string>();
    for (const definition of deduped.values()) {
      currentKeys.add(definition.featureKey);

      const result = await this.featureDefinitions.upsertDefinition(definition);
      if (result.status === 'created') created++;
      if (result.status === 'updated') updated++;
      if (result.status === 'unchanged') unchanged++;
    }

    if (pruneStale) {
      for (const packageName of touchedPackages) {
        const existing =
          await this.featureDefinitions.findByPackageName(packageName);
        for (const definition of existing) {
          if (currentKeys.has(definition.featureKey)) {
            continue;
          }

          await definition.delete();
          deleted++;
        }
      }
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
