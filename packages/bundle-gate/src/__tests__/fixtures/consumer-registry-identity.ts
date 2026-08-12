/**
 * Production-consumer registry identity fixture (#2308).
 *
 * This entry is bundled and executed in a fresh Node process. It models the
 * generated SvelteKit registration file by importing real constructors and
 * re-registering each one with an explicit package and single-object manifest.
 */
import {
  ObjectRegistry,
  resolveDatabase,
  type SmartObjectManifest,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { FieldPolicy, FieldPolicyCollection } from '@happyvertical/smrt-fields';
import fieldsManifestJson from '@happyvertical/smrt-fields/manifest.json';

function isolatedManifest(
  manifest: SmartObjectManifest,
  key: string,
): SmartObjectManifest {
  const object = manifest.objects[key];
  if (!object) throw new Error(`Missing fixture manifest object: ${key}`);
  return { ...manifest, objects: { [key]: object } };
}

function fixtureManifest(
  packageName: string,
  className: string,
  tableName: string,
  fieldName: string,
): SmartObjectManifest {
  const key = `${packageName}:${className}`;
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName,
    objects: {
      [key]: {
        name: className,
        className,
        qualifiedName: key,
        packageName,
        collection: `${className.toLowerCase()}s`,
        filePath: `/provider/dist/${className}.js`,
        fields: { [fieldName]: { type: 'text', required: true } },
        methods: {},
        decoratorConfig: { tableName },
        schema: {
          tableName,
          ddl: '',
          columns: { [fieldName]: { type: 'TEXT', notNull: true } },
          indexes: [],
          version: 'fixture',
        },
      },
    },
  } as SmartObjectManifest;
}

const fieldsManifest = fieldsManifestJson as unknown as SmartObjectManifest;
const fieldPolicyManifest = isolatedManifest(
  fieldsManifest,
  '@happyvertical/smrt-fields:FieldPolicy',
);

// This is the exact explicit registration contract emitted by the generator.
// It must rebuild metadata for the imported constructor even when the bundled
// decorator registered it earlier under a deconflicted name or consumer path.
ObjectRegistry.register(FieldPolicy, {
  name: 'FieldPolicy',
  packageName: '@happyvertical/smrt-fields',
  _manifest: fieldPolicyManifest,
  _manifestKey: '@happyvertical/smrt-fields:FieldPolicy',
});

const fieldPolicyRegistration =
  ObjectRegistry.getClassByConstructor(FieldPolicy);
const fieldPolicyMatches = ObjectRegistry.findClassesByName('FieldPolicy');
const collectionItemClass = (
  FieldPolicyCollection as unknown as { _itemClass?: typeof SmrtObject }
)._itemClass;

// Execute the downstream operation that originally failed: resolve the
// collection, migrate a fresh database, and list the empty table.
const db = await resolveDatabase(':memory:');
await db.query('CREATE TABLE "_smrt_field_policies" ("id" TEXT PRIMARY KEY)');
const policies = new FieldPolicyCollection({ db });
await policies.initialize();
const emptyPolicies = await policies.list();
await (db as unknown as { close?: () => Promise<void> }).close?.();

// Two distinct packages may legitimately export the same simple class name.
// Both explicit registrations must coexist with their own metadata.
const SharedThingA = class SharedThing extends SmrtObject {};
const SharedThingB = class SharedThing2 extends SmrtObject {};
const sharedAManifest = fixtureManifest(
  '@test/a',
  'SharedThing',
  'a_shared_things',
  'alpha',
);
const sharedBManifest = fixtureManifest(
  '@test/b',
  'SharedThing',
  'b_shared_things',
  'beta',
);
ObjectRegistry.registerFieldDecorator('SharedThing', 'alpha', {
  type: 'text',
  required: true,
});
ObjectRegistry.registerFieldDecorator('SharedThing2', 'beta', {
  type: 'text',
  required: true,
});
const sharedDecoratorKeys = {
  a: [...ObjectRegistry.getFieldDecorators(SharedThingA.name).keys()],
  b: [...ObjectRegistry.getFieldDecorators(SharedThingB.name).keys()],
};
ObjectRegistry.register(SharedThingA, {
  name: 'SharedThing',
  packageName: '@test/a',
  _manifest: sharedAManifest,
  _manifestKey: '@test/a:SharedThing',
});
ObjectRegistry.register(SharedThingB, {
  name: 'SharedThing',
  packageName: '@test/b',
  _manifest: sharedBManifest,
  _manifestKey: '@test/b:SharedThing',
});

// Rollup deconfliction changes the runtime constructor name. Explicit
// constructor identity must still replace the earlier decorator-style entry
// and load the logical object's fields/default table from its manifest.
const RenamedProviderObject = class RenamedProviderObject2 extends SmrtObject {};
ObjectRegistry.register(RenamedProviderObject);
const renamedManifest = fixtureManifest(
  '@test/renamed',
  'RenamedProviderObject',
  'renamed_provider_objects',
  'key',
);
ObjectRegistry.register(RenamedProviderObject, {
  name: 'RenamedProviderObject',
  packageName: '@test/renamed',
  _manifest: renamedManifest,
  _manifestKey: '@test/renamed:RenamedProviderObject',
});

// A later provider manifest must never adopt a distinct explicit consumer,
// even when the simple name and table happen to match.
const ConsumerConflict = class SharedConflict extends SmrtObject {};
ObjectRegistry.register(ConsumerConflict, {
  name: 'SharedConflict',
  packageName: '@test/consumer',
  tableName: 'shared_conflicts',
});
ObjectRegistry.registerPackageManifest(
  fixtureManifest(
    '@test/provider',
    'SharedConflict',
    'shared_conflicts',
    'providerOnly',
  ),
);

const sharedA = ObjectRegistry.getClassByQualifiedName(
  '@test/a:SharedThing' as never,
);
const sharedB = ObjectRegistry.getClassByQualifiedName(
  '@test/b:SharedThing' as never,
);
const renamed = ObjectRegistry.getClassByConstructor(RenamedProviderObject);

console.log(
  `SMRT_REGISTRY_RESULT=${JSON.stringify({
    fieldPolicy: {
      packageName: fieldPolicyRegistration?.packageName,
      qualifiedName: fieldPolicyRegistration?.qualifiedName,
      tableName: fieldPolicyRegistration?.schema?.tableName,
      fieldNames: [...(fieldPolicyRegistration?.fields.keys() ?? [])].sort(),
      matchCount: fieldPolicyMatches.length,
      collectionItemMatches: collectionItemClass === FieldPolicy,
      emptyListCount: emptyPolicies.length,
    },
    sharedA: {
      packageName: sharedA?.packageName,
      tableName: sharedA?.schema?.tableName,
      fieldNames: [...(sharedA?.fields.keys() ?? [])].sort(),
      constructorMatches: sharedA?.constructor === SharedThingA,
    },
    sharedB: {
      packageName: sharedB?.packageName,
      tableName: sharedB?.schema?.tableName,
      fieldNames: [...(sharedB?.fields.keys() ?? [])].sort(),
      constructorMatches: sharedB?.constructor === SharedThingB,
    },
    sharedMatchCount: ObjectRegistry.findClassesByName('SharedThing').length,
    sharedRuntimeNames: [SharedThingA.name, SharedThingB.name],
    sharedDecoratorKeys,
    renamed: {
      packageName: renamed?.packageName,
      qualifiedName: renamed?.qualifiedName,
      tableName: renamed?.schema?.tableName,
      fieldNames: [...(renamed?.fields.keys() ?? [])].sort(),
      staleRuntimeNameCount: ObjectRegistry.findClassesByName(
        'RenamedProviderObject2',
      ).length,
    },
    consumerConflictPackage:
      ObjectRegistry.getClassByConstructor(ConsumerConflict)?.packageName,
    providerConflictPackage: ObjectRegistry.getClassByQualifiedName(
      '@test/provider:SharedConflict' as never,
    )?.packageName,
  })}`,
);
