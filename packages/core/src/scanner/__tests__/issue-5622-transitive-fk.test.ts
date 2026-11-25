import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, assert, describe, expect, it } from 'vitest';
import { foreignKey } from '../../decorators/index.js';
import {
  clearManifestCache,
  loadExternalManifestSync,
  loadManifestFromPathSync,
} from '../../manifest/manifest-loader.js';
import {
  computeSchemaFingerprint,
  tryComputeManifestSchemaFingerprint,
} from '../../migrations/schema-fingerprint.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { SchemaGenerator } from '../../schema/generator.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { ManifestGenerator } from '../manifest-generator.js';
import type { SmartObjectDefinition, SmartObjectManifest } from '../types.js';

const APP = '@fk5622/app';
const CHILD = '@fk5622/child';
const BASE = '@fk5622/base';
const originalCwd = process.cwd();
let scratch: string | undefined;
const restoreRegistry = snapshotObjectRegistryState();
afterEach(() => {
  process.chdir(originalCwd);
  clearManifestCache();
  restoreRegistry();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
function model(
  packageName: string,
  className: string,
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    packageName,
    collection: `${className.toLowerCase()}s`,
    filePath: `/fixture/${className}.ts`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    extends: 'SmrtObject',
    ...extra,
  };
}
function manifest(
  packageName: string,
  objects: SmartObjectDefinition[],
  smrtDependencies: string[] = [],
): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 0,
    moduleType: 'smrt',
    packageName,
    smrtDependencies,
    objects: Object.fromEntries(
      objects.map((obj) => [obj.qualifiedName ?? obj.className, obj]),
    ),
  };
}
function writePackage(dir: string, content: SmartObjectManifest) {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: content.packageName,
      type: 'module',
      exports: { './manifest.json': './dist/manifest.json' },
      dependencies: Object.fromEntries(
        (content.smrtDependencies ?? []).map((name) => [name, '1.0.0']),
      ),
    }),
  );
  const path = join(dir, 'dist', 'manifest.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}
function setup(
  hoisted: boolean,
  mode: 'normal' | 'missing' | 'wrong' | 'cycle' = 'normal',
) {
  clearManifestCache();
  scratch = mkdtempSync(join(tmpdir(), 'smrt-fk5622-transitive-'));
  const app = join(scratch, 'app');
  const childScope = join(scratch, 'store', 'child', 'node_modules', '@fk5622');
  const baseDir = join(
    scratch,
    'store',
    'base',
    'node_modules',
    '@fk5622',
    'base',
  );
  const childDir = join(childScope, 'child');
  mkdirSync(join(app, 'node_modules', '@fk5622'), { recursive: true });
  mkdirSync(childScope, { recursive: true });
  const root = model(BASE, 'Ancestor', {
    decoratorConfig: {
      tableStrategy: 'sti',
      tableName: 'fk5622_transitive_entities',
      idType: 'uuid',
    },
  });
  const intermediate = model(BASE, 'Entity', { extends: 'Ancestor' });
  const base = manifest(BASE, [root, intermediate]);
  new ManifestGenerator().generateSchemas(base);
  delete intermediate.schema;
  if (mode === 'cycle') {
    intermediate.extends = 'Person';
    intermediate.extendsQualified = `${CHILD}:Person`;
  }
  if (mode === 'wrong') {
    delete base.objects[`${BASE}:Entity`];
    base.objects['@wrong/owner:Entity'] = {
      ...intermediate,
      packageName: '@wrong/owner',
      qualifiedName: '@wrong/owner:Entity',
    };
  }
  if (mode !== 'missing') {
    writePackage(baseDir, base);
    symlinkSync(baseDir, join(childScope, 'base'));
    if (hoisted)
      symlinkSync(baseDir, join(app, 'node_modules', '@fk5622', 'base'));
  }
  const child = manifest(
    CHILD,
    [
      model(CHILD, 'Person', {
        extends: 'Entity',
        extendsQualified: `${BASE}:Entity`,
      }),
    ],
    [BASE],
  );
  const childPath = writePackage(childDir, child);
  symlinkSync(childDir, join(app, 'node_modules', '@fk5622', 'child'));
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: APP, dependencies: { [CHILD]: '1.0.0' } }),
  );
  process.chdir(app);
  const build = manifest(
    APP,
    [
      model(APP, 'Subscription', {
        fields: {
          personId: {
            type: 'foreignKey',
            related: `${CHILD}:Person`,
            _meta: { onUpdate: 'NO ACTION' },
          },
        },
        decoratorConfig: { tableName: 'fk5622_transitive_subscriptions' },
      }),
    ],
    [CHILD],
  );
  return { build, childPath };
}

describe('transitive STI FK owner manifests (#5622 R1)', () => {
  it.each([
    true,
    false,
  ])('resolves a public-loader ancestor with hoisted=%s and preserves runtime fingerprints', async (hoisted) => {
    const { build, childPath } = setup(hoisted);
    if (!hoisted) expect(loadExternalManifestSync(BASE)).toBeNull();
    assert(
      loadManifestFromPathSync(childPath),
      'public path loading must preserve owner provenance',
    );
    assert(loadExternalManifestSync(CHILD));
    new ManifestGenerator().applyGenerationPasses(build);
    const schema = build.objects[`${APP}:Subscription`].schema;
    assert(schema);
    expect(schema.columns.person_id.foreignKey?.table).toBe(
      'fk5622_transitive_entities',
    );
    class Ancestor extends SmrtObject {}
    class Entity extends Ancestor {}
    class Person extends Entity {}
    class Subscription extends SmrtObject {}
    smrt({
      packageName: BASE,
      tableStrategy: 'sti',
      tableName: 'fk5622_transitive_entities',
      idType: 'uuid',
    })(Ancestor);
    smrt({ packageName: BASE })(Entity);
    smrt({ packageName: CHILD })(Person);
    foreignKey(`${CHILD}:Person`, { onUpdate: 'NO ACTION' })(
      Subscription.prototype,
      'personId',
    );
    smrt({ packageName: APP, tableName: schema.tableName })(Subscription);
    const runtime = new SchemaGenerator().generateSchemaFromRegistry(
      `${APP}:Subscription`,
      schema.tableName,
      await ObjectRegistry.getAllFields(`${APP}:Subscription`),
      { registry: ObjectRegistry },
    );
    expect(schema.columns.person_id.foreignKey).toEqual(
      runtime.columns.person_id.foreignKey,
    );
    expect(schema.columns.person_id.type).toBe('UUID');
    expect(computeSchemaFingerprint([runtime])).toBe(
      tryComputeManifestSchemaFingerprint(build),
    );
    for (const engine of ['sqlite', 'postgres', 'duckdb'] as const) {
      expect(new SchemaGenerator().generateSQL(runtime, engine)).toContain(
        'REFERENCES "fk5622_transitive_entities"',
      );
    }
  });
  it('keeps owner-context resolution separate from an app-cached installation', () => {
    const { childPath } = setup(false);
    const shadow = manifest(BASE, [
      model(BASE, 'Entity', {
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'wrong_app_entities',
        },
      }),
    ]);
    assert(scratch);
    writePackage(
      join(scratch, 'app', 'node_modules', '@fk5622', 'base'),
      shadow,
    );
    const appCopy = loadExternalManifestSync(BASE);
    assert(appCopy);
    const child = loadManifestFromPathSync(childPath);
    assert(child);
    const owned = loadExternalManifestSync(BASE, { fromManifest: child });
    expect(owned?.objects[`${BASE}:Ancestor`].schema?.tableName).toBe(
      'fk5622_transitive_entities',
    );
    expect(loadExternalManifestSync(BASE)).toBe(appCopy);
    expect(
      loadExternalManifestSync(BASE, { fromManifest: { ...child } }),
    ).toBeNull();
  });

  it.each([
    'missing',
    'wrong',
    'cycle',
  ] as const)('keeps %s qualified ancestry bounded without phantom constraints', (mode) => {
    const { build } = setup(false, mode);
    new ManifestGenerator().applyGenerationPasses(build);
    expect(
      build.objects[`${APP}:Subscription`].schema?.columns.person_id.foreignKey,
    ).toBeUndefined();
  });
});
