/** Registry fixture isolation, without a test-runner runtime dependency. */
import { snapshotRegisteredRetiredTables } from '../migrations/retired-tables.js';
import { snapshotGeneratedClassState } from '../registry/generated-state.js';
import { snapshotRuntimeOverrides } from '../registry/runtime-overrides.js';
import {
  getJunctionItemConstructors,
  getLegacyFieldDecorators,
} from '../registry/shared-state.js';
import { snapshotSubtypeLineage } from '../registry/subtype-lineage.js';
import type { RegisteredClass } from '../registry/types.js';
import { ObjectRegistry } from '../registry.js';

/**
 * Internal test-only view onto ObjectRegistry's private registration maps.
 * Snapshot/restore copies these Maps opaquely (only a registration's
 * internal-model stamps are read, to restore them by value), so the value
 * types are `unknown` rather than the registry's concrete
 * registration shapes. This is the single boundary where test utilities reach
 * into registry internals; access goes through a documented cast below.
 */
interface RegistryTestSurface {
  // Release B (#1133) removed classNameMap — the `classes` Map below is the
  // single source of truth for every case-insensitive lookup.
  classes: Map<string, unknown>;
  collectionTableNames: Map<string, string>;
  collections: Map<string, unknown>;
  fieldDecorators: Map<string, Map<string, unknown>>;
  constructorFieldDecorators: Map<Function, Map<string, unknown>>;
  constructorTenantScopedDeclarations: Map<Function, Record<string, unknown>>;
  nextDbId: number;
  stiSiblingsLoaded: Set<string>;
  clear(): void;
}

type RegistryTestState = Pick<
  RegistryTestSurface,
  | 'classes'
  | 'collectionTableNames'
  | 'collections'
  | 'fieldDecorators'
  | 'constructorFieldDecorators'
  | 'constructorTenantScopedDeclarations'
  | 'nextDbId'
  | 'stiSiblingsLoaded'
>;

function cloneNestedMap<Key>(
  source: Map<Key, Map<string, unknown>>,
): Map<Key, Map<string, unknown>> {
  return new Map(Array.from(source, ([key, value]) => [key, new Map(value)]));
}

function cloneRecordMap<Key>(
  source: Map<Key, Record<string, unknown>>,
): Map<Key, Record<string, unknown>> {
  return new Map(Array.from(source, ([key, value]) => [key, { ...value }]));
}

function getRegistryForTests(): RegistryTestSurface {
  // Documented boundary cast: ObjectRegistry's registration maps are private
  // statics; tests snapshot them to isolate registry mutations.
  return ObjectRegistry as unknown as RegistryTestSurface;
}

/**
 * Snapshot ObjectRegistry state and return a restore function for manifest-heavy
 * tests that mutate registry internals at runtime.
 */
export function snapshotObjectRegistryState(): () => void {
  const restoreGenerated = snapshotGeneratedClassState();
  const restoreRetired = snapshotRegisteredRetiredTables();
  // clear() also drops replacement lineage, the run-time coexistence set and
  // consumer policies; without them a replaced parent resolves to its
  // replacement and its chain loops.
  const restoreLineage = snapshotSubtypeLineage();
  const restoreOverrides = snapshotRuntimeOverrides();
  const legacyFields = new Map(
    Array.from(getLegacyFieldDecorators(), ([key, fields]) => [
      key,
      new Map(fields),
    ]),
  );
  const junctionItems = new Set(getJunctionItemConstructors());
  const registry = getRegistryForTests();
  // Registrations are restored as the same objects, and the registry stamps
  // them in place (a junction collection registered after the snapshot marks
  // its already-registered item), so their stamps are saved by value.
  const stamps = new Map(
    Array.from(
      registry.classes.values() as Iterable<RegisteredClass>,
      (entry) => [
        entry,
        {
          internalKind: entry.internalKind,
          junctionCollection: entry.junctionCollection,
          defaultedExposure: entry.defaultedExposure
            ? [...entry.defaultedExposure]
            : undefined,
        },
      ],
    ),
  );
  const snapshot: RegistryTestState = {
    classes: new Map(registry.classes),
    collectionTableNames: new Map(registry.collectionTableNames),
    collections: new Map(registry.collections),
    fieldDecorators: cloneNestedMap(registry.fieldDecorators),
    constructorFieldDecorators: cloneNestedMap(
      registry.constructorFieldDecorators,
    ),
    constructorTenantScopedDeclarations: cloneRecordMap(
      registry.constructorTenantScopedDeclarations,
    ),
    nextDbId: registry.nextDbId,
    stiSiblingsLoaded: new Set(registry.stiSiblingsLoaded),
  };

  return () => {
    registry.clear();
    restoreLineage();
    restoreOverrides();
    for (const [key, value] of legacyFields) {
      getLegacyFieldDecorators().set(key, new Map(value));
    }
    for (const ctor of junctionItems) getJunctionItemConstructors().add(ctor);

    for (const [key, value] of snapshot.classes) {
      registry.classes.set(key, value);
    }
    for (const [entry, saved] of stamps) {
      for (const field of [
        'internalKind',
        'junctionCollection',
        'defaultedExposure',
      ] as const) {
        if (saved[field] === undefined) delete entry[field];
        else Object.assign(entry, { [field]: saved[field] });
      }
    }

    for (const [key, value] of snapshot.collections) {
      registry.collections.set(key, value);
    }

    for (const [key, value] of snapshot.collectionTableNames) {
      registry.collectionTableNames.set(key, value);
    }

    for (const [key, value] of snapshot.fieldDecorators) {
      registry.fieldDecorators.set(key, new Map(value));
    }

    for (const [key, value] of snapshot.constructorFieldDecorators) {
      registry.constructorFieldDecorators.set(key, new Map(value));
    }

    for (const [key, value] of snapshot.constructorTenantScopedDeclarations) {
      registry.constructorTenantScopedDeclarations.set(key, { ...value });
    }

    for (const value of snapshot.stiSiblingsLoaded) {
      registry.stiSiblingsLoaded.add(value);
    }

    registry.nextDbId = snapshot.nextDbId;
    ObjectRegistry.invalidateAllInheritanceCaches();
    restoreGenerated();
    restoreRetired();
  };
}
