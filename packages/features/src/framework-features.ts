/**
 * Framework feature definitions (#4761): feature keys that are not owned by a
 * single `@smrt()` class, such as the standard paid keys a subscription plan
 * grants (`inference.hosted`).
 *
 * Class features keep their `<qualifiedClassName>#<localId>` keys. Framework
 * keys are dotted identifiers (`namespace.name`) with no `#` or `:`, so the
 * two key spaces can never collide. `FeatureResolver` reads a framework
 * key's default from this registry first; `FeatureSyncService
 * .syncFrameworkDefinitions()` mirrors them to `_smrt_feature_definitions` so
 * the settings screen can list and override them.
 *
 * The registry lives on `globalThis` (like `ObjectRegistry`) so every module
 * instance shares one set, and it is seeded lazily with
 * {@link STANDARD_FEATURES} rather than by an import side effect.
 */
import { STANDARD_FEATURES } from './standard-features.js';
import type { FeatureMetadata } from './types.js';

export interface FrameworkFeatureDefinition {
  /** Dotted key, e.g. `inference.hosted`. Persisted; never rename. */
  featureKey: string;
  /** Package that owns the definition (used for sync ownership). */
  packageName: string;
  label?: string;
  description?: string;
  defaultEnabled: boolean;
  /** Free-form metadata; paid keys carry `paid: true`. */
  metadata?: FeatureMetadata & { paid?: boolean };
}

const FRAMEWORK_KEY_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;

const REGISTRY_SLOT = Symbol.for(
  '@happyvertical/smrt-features:framework-features',
);

type RegistryHolder = Record<
  symbol,
  Map<string, FrameworkFeatureDefinition> | undefined
>;

function registry(): Map<string, FrameworkFeatureDefinition> {
  const holder = globalThis as unknown as RegistryHolder;
  let map = holder[REGISTRY_SLOT];
  if (!map) {
    map = new Map();
    holder[REGISTRY_SLOT] = map;
    for (const definition of STANDARD_FEATURES) {
      map.set(definition.featureKey, definition);
    }
  }
  return map;
}

/** Whether `featureKey` has the framework (dotted) key shape. */
export function isFrameworkFeatureKey(featureKey: string): boolean {
  return FRAMEWORK_KEY_PATTERN.test(featureKey);
}

/**
 * Register a framework feature definition. Re-registering an identical
 * definition is a no-op (module instances may load twice); a conflicting one
 * throws, because the key is a persisted identifier with one meaning.
 */
export function defineFrameworkFeature(
  definition: FrameworkFeatureDefinition,
): FrameworkFeatureDefinition {
  if (!isFrameworkFeatureKey(definition.featureKey)) {
    throw new Error(
      `Invalid framework feature key "${definition.featureKey}". Expected a dotted key such as "inference.hosted".`,
    );
  }
  if (!definition.packageName) {
    throw new Error(
      `Framework feature "${definition.featureKey}" needs a packageName.`,
    );
  }
  const frozen = Object.freeze({
    ...definition,
    ...(definition.metadata
      ? { metadata: Object.freeze({ ...definition.metadata }) }
      : {}),
  });
  const map = registry();
  const existing = map.get(definition.featureKey);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(frozen)) {
      throw new Error(
        `Framework feature "${definition.featureKey}" is already defined by ${existing.packageName} with different settings.`,
      );
    }
    return existing;
  }
  map.set(definition.featureKey, frozen);
  return frozen;
}

/** The framework definition for `featureKey`, if registered. */
export function getFrameworkFeature(
  featureKey: string,
): FrameworkFeatureDefinition | undefined {
  return registry().get(featureKey);
}

/** Every registered framework definition, standard keys included. */
export function listFrameworkFeatures(): FrameworkFeatureDefinition[] {
  return Array.from(registry().values());
}
