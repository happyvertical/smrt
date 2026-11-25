import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  foreignKey,
  ObjectRegistry,
  smrt,
  SmrtObject,
} from '../../packages/core/dist/index.js';
import {
  loadExternalManifestSync,
  loadManifestFromPathSync,
} from '../../packages/core/dist/manifest.js';
import {
  computeSchemaFingerprint,
  tryComputeManifestSchemaFingerprint,
} from '../../packages/core/dist/migrations.js';
import { ManifestGenerator } from '../../packages/core/dist/scanner/manifest-generator.js';
import { SchemaGenerator } from '../../packages/core/dist/schema.js';

const APP = '@fk5622/built-app';
const CHILD = '@fk5622/built-child';
const BASE = '@fk5622/built-base';
function model(packageName, className, extra = {}) {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    packageName,
    collection: `${className.toLowerCase()}s`,
    filePath: `/fixture/${className}.js`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    extends: 'SmrtObject',
    ...extra,
  };
}
function manifest(packageName, objects, smrtDependencies = []) {
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName,
    smrtDependencies,
    objects: Object.fromEntries(
      objects.map((object) => [object.qualifiedName, object]),
    ),
  };
}
function publish(dir, content) {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: content.packageName,
      exports: { './manifest.json': './dist/manifest.json' },
    }),
  );
  const path = join(dir, 'dist', 'manifest.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

async function checkOwningAncestor(aggregateBase) {
  const cwd = process.cwd();
  const scratch = mkdtempSync(join(tmpdir(), 'smrt-built-transitive-fk-'));
  try {
    ObjectRegistry.clear();
    const app = join(scratch, 'app');
    const childScope = join(
      scratch,
      'store',
      'child',
      'node_modules',
      '@fk5622',
    );
    const baseDir = join(
      scratch,
      'store',
      'base',
      'node_modules',
      '@fk5622',
      'built-base',
    );
    const childDir = join(childScope, 'built-child');
    mkdirSync(join(app, 'node_modules', '@fk5622'), { recursive: true });
    mkdirSync(childScope, { recursive: true });
    const base = manifest(BASE, [
      model(BASE, 'Entity', {
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'built_fk5622_entities',
          idType: 'uuid',
        },
      }),
    ]);
    new ManifestGenerator().generateSchemas(base);
    publish(baseDir, base);
    symlinkSync(baseDir, join(childScope, 'built-base'));
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
    const childPath = publish(childDir, child);
    const published = readFileSync(childPath, 'utf8');
    symlinkSync(childDir, join(app, 'node_modules', '@fk5622', 'built-child'));
    if (aggregateBase) {
      const appBase = manifest(BASE, [
        model(BASE, 'Entity', {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'wrong_app_entities',
            idType: 'uuid',
          },
        }),
      ]);
      new ManifestGenerator().generateSchemas(appBase);
      publish(join(app, 'node_modules', '@fk5622', 'built-base'), appBase);
    }
    process.chdir(app);
    if (!aggregateBase)
      assert.equal(
        loadExternalManifestSync(BASE),
        null,
        'ancestor is not hoisted into the app',
      );
    const loaded = loadManifestFromPathSync(childPath);
    assert.ok(loaded);
    assert.equal(
      JSON.stringify(loaded),
      published,
      'load provenance stays outside serialized metadata',
    );
    const build = manifest(
      APP,
      [
        model(APP, 'Subscription', {
          decoratorConfig: { tableName: 'built_fk5622_subscriptions' },
          fields: {
            personId: {
              type: 'foreignKey',
              related: `${CHILD}:Person`,
              _meta: { onUpdate: 'NO ACTION' },
            },
          },
        }),
      ],
      aggregateBase ? [CHILD, BASE] : [CHILD],
    );
    new ManifestGenerator().applyGenerationPasses(build);
    const schema = build.objects[`${APP}:Subscription`].schema;
    assert.equal(
      schema.columns.person_id.foreignKey?.table,
      'built_fk5622_entities',
    );
    class Entity extends SmrtObject {}
    class Person extends Entity {}
    class Subscription extends SmrtObject {}
    ObjectRegistry.register(Entity, {
      ...base.objects[`${BASE}:Entity`].decoratorConfig,
      name: 'Entity',
      packageName: BASE,
      _manifest: base,
      _manifestKey: `${BASE}:Entity`,
    });
    ObjectRegistry.register(Person, {
      name: 'Person',
      packageName: CHILD,
      _manifest: child,
      _manifestKey: `${CHILD}:Person`,
    });
    foreignKey(`${CHILD}:Person`, { onUpdate: 'NO ACTION' })(
      Subscription.prototype,
      'personId',
    );
    smrt({ packageName: APP, tableName: 'built_fk5622_subscriptions' })(
      Subscription,
    );
    const runtime = new SchemaGenerator().generateSchemaFromRegistry(
      `${APP}:Subscription`,
      schema.tableName,
      await ObjectRegistry.getAllFields(`${APP}:Subscription`),
      { registry: ObjectRegistry },
    );
    assert.equal(
      ObjectRegistry.getAllSchemasAsDefinitions().built_fk5622_subscriptions
        .columns.person_id.foreignKey?.table,
      'built_fk5622_entities',
    );
    assert.deepEqual(
      schema.columns.person_id.foreignKey,
      runtime.columns.person_id.foreignKey,
    );
    assert.equal(
      computeSchemaFingerprint([runtime]),
      tryComputeManifestSchemaFingerprint(build),
    );
    assert.equal(readFileSync(childPath, 'utf8'), published);
  } finally {
    process.chdir(cwd);
    ObjectRegistry.clear();
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const aggregateBase of [false, true]) {
  test(`built public loader selects owning STI ancestor with aggregateBase=${aggregateBase} (#5622)`, () =>
    checkOwningAncestor(aggregateBase));
}

test('current local build outranks a prior package cache and migrates in production (#5622)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'smrt-built-local-fk-'));
  try {
    ObjectRegistry.clear();
    const fixture = (table) =>
      manifest(APP, [
        model(APP, 'Entity', {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: table,
            idType: 'uuid',
          },
        }),
        model(APP, 'Person', {
          extends: 'Entity',
          extendsQualified: `${APP}:Entity`,
        }),
        model(APP, 'Subscription', {
          decoratorConfig: { tableName: 'fk5622_subscriptions' },
          fields: {
            personId: {
              type: 'foreignKey',
              related: `${APP}:Person`,
              _meta: { onUpdate: 'NO ACTION' },
            },
          },
        }),
      ]);
    const prior = fixture('obsolete_local_entities');
    new ManifestGenerator().applyGenerationPasses(prior);
    assert.ok(loadManifestFromPathSync(publish(join(scratch, 'prior'), prior)));
    const build = fixture('fk5622_entities');
    new ManifestGenerator().applyGenerationPasses(build);
    const authored = fixture('fk5622_entities');
    class Entity extends SmrtObject {}
    class Person extends Entity {}
    class Subscription extends SmrtObject {}
    for (const [ctor, name] of [
      [Entity, 'Entity'],
      [Person, 'Person'],
      [Subscription, 'Subscription'],
    ]) {
      const key = `${APP}:${name}`,
        entry = authored.objects[key];
      ObjectRegistry.register(ctor, {
        ...entry.decoratorConfig,
        name,
        packageName: APP,
        _manifest: { ...authored, objects: { [key]: entry } },
        _manifestKey: key,
      });
    }
    const runtime = new SchemaGenerator().generateSchemaFromRegistry(
      `${APP}:Subscription`,
      'fk5622_subscriptions',
      await ObjectRegistry.getAllFields(`${APP}:Subscription`),
      { registry: ObjectRegistry },
    );
    assert.equal(
      runtime.columns.person_id.foreignKey?.table,
      'fk5622_entities',
    );
    assert.equal(
      ObjectRegistry.getAllSchemasAsDefinitions().fk5622_subscriptions.columns
        .person_id.foreignKey?.table,
      'fk5622_entities',
    );
    assert.deepEqual(
      build.objects[`${APP}:Subscription`].schema.columns.person_id.foreignKey,
      runtime.columns.person_id.foreignKey,
    );
    assert.equal(
      tryComputeManifestSchemaFingerprint({
        ...build,
        objects: { source: build.objects[`${APP}:Subscription`] },
      }),
      computeSchemaFingerprint([runtime]),
    );
    const path = join(scratch, 'manifest.json');
    const artifact = JSON.stringify(build);
    writeFileSync(path, artifact);
    const worker = fileURLToPath(
      new URL('./fixtures/issue-5622-process.mjs', import.meta.url),
    );
    for (const phase of ['migrate', 'query']) {
      const result = spawnSync(
        process.execPath,
        [worker, phase, path, join(scratch, 'app.db')],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_ENV: 'production',
            SMRT_BUILD_MANIFEST: path,
            SMRT_ALLOW_UNMIGRATED_START: '',
            VITEST: '',
          },
        },
      );
      assert.equal(
        result.status,
        0,
        `${phase}: ${result.stdout}\n${result.stderr}`,
      );
      if (phase === 'query')
        assert.equal(
          JSON.parse(result.stdout.trim().split('\n').at(-1)).count,
          0,
        );
    }
    assert.equal(readFileSync(path, 'utf8'), artifact);
  } finally {
    ObjectRegistry.clear();
    rmSync(scratch, { recursive: true, force: true });
  }
});
