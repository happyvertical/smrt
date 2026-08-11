import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { smrtConsumer } from './index';

describe('smrtConsumer registration generation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(import.meta.dirname, `__test-consumer-${Date.now()}`);

    mkdirSync(join(tmpDir, 'node_modules', '@test', 'pkg', 'dist'), {
      recursive: true,
    });

    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'consumer-app',
        version: '1.0.0',
      }),
    );

    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        version: '1.2.3',
        exports: {
          '.': './dist/index.js',
        },
      }),
    );

    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/pkg',
        objects: {
          ExternalThing: {
            className: 'ExternalThing',
            collection: 'externalthings',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          ExternalThingCollection: {
            className: 'ExternalThingCollection',
            exportName: 'ExternalThingCollection',
            collection: 'externalthings',
            extends: 'SmrtCollection',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          LegacyThingCollection: {
            className: 'LegacyThingCollection',
            exportName: 'LegacyThingCollection',
            collection: 'legacythings',
            extendsTypeArg: 'ExternalThing',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          SpecializedThingCollection: {
            className: 'SpecializedThingCollection',
            exportName: 'SpecializedThingCollection',
            collection: 'specializedthings',
            extends: 'ExternalThingCollection',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('leaves optional native provider binaries to the Node runtime', async () => {
    const plugin = smrtConsumer({ projectRoot: tmpDir });
    const config = await plugin.config?.call({} as any, {} as any, {
      command: 'build',
      mode: 'production',
    });
    const external = (config as any).build.rollupOptions.external as RegExp[];
    expect(external).toHaveLength(1);
    expect(external[0].test('/tmp/provider/native-addon.node')).toBe(true);
    expect(external[0].test('/tmp/provider/index.js')).toBe(false);
  });

  it('should write explicit package names into .smrt/register.js', async () => {
    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await plugin.buildStart?.call({} as any);

    const registerPath = join(tmpDir, '.smrt', 'register.js');
    expect(existsSync(registerPath)).toBe(true);

    const content = readFileSync(registerPath, 'utf-8');
    expect(content).toContain(
      "import * as __smrt_provider_0 from '@test/pkg';",
    );
    expect(content).toContain(
      'const __smrt_consumer_0 = getSmrtExport(__smrt_provider_0, "ExternalThing");',
    );
    expect(content).toContain(
      'if (__smrt_consumer_0) ObjectRegistry.register(__smrt_consumer_0, { name: "ExternalThing", packageName: "@test/pkg", _manifest: smrtRegistrationManifests["ExternalThing"], _manifestKey: "ExternalThing" });',
    );
    expect(content).toContain(
      "console.log('[smrt:register] Registered 1 external object');",
    );
    expect(content).not.toContain('ObjectRegistry.register(__smrt_consumer_1');
    expect(content).not.toContain('ObjectRegistry.register(__smrt_consumer_2');
    expect(content).not.toContain('ObjectRegistry.register(__smrt_consumer_3');

    const manifestLiteral = content.match(
      /const smrtRegistrationManifests = JSON\.parse\((.+)\);/,
    )?.[1];
    expect(manifestLiteral).toBeDefined();
    const registrationManifests = JSON.parse(
      JSON.parse(manifestLiteral as string),
    );
    expect(registrationManifests.ExternalThing).toMatchObject({
      packageName: '@test/pkg',
      objects: {
        ExternalThing: {
          className: 'ExternalThing',
          packageName: '@test/pkg',
        },
      },
    });
  });

  it('aliases same-name exports and isolates their registration manifests', async () => {
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'pkg', 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/pkg',
        objects: {
          '@test/pkg:SharedThing': {
            className: 'SharedThing',
            qualifiedName: '@test/pkg:SharedThing',
            collection: 'pkg_shared_things',
            fields: { alpha: { type: 'string' } },
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    mkdirSync(join(tmpDir, 'node_modules', '@test', 'other', 'dist'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'other', 'package.json'),
      JSON.stringify({
        name: '@test/other',
        version: '4.5.6',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'other', 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/other',
        objects: {
          '@test/other:SharedThing': {
            className: 'SharedThing',
            qualifiedName: '@test/other:SharedThing',
            collection: 'other_shared_things',
            fields: { beta: { type: 'number' } },
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      packages: ['@test/pkg', '@test/other'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    await plugin.buildStart?.call({} as any);

    const content = readFileSync(join(tmpDir, '.smrt', 'register.js'), 'utf-8');
    expect(content).toContain(
      "import * as __smrt_provider_1 from '@test/pkg';",
    );
    expect(content).toContain(
      "import * as __smrt_provider_0 from '@test/other';",
    );
    expect(content).toContain(
      'const __smrt_consumer_0 = getSmrtExport(__smrt_provider_1, "SharedThing");',
    );
    expect(content).toContain(
      'const __smrt_consumer_1 = getSmrtExport(__smrt_provider_0, "SharedThing");',
    );
    expect(content).toContain(
      'if (__smrt_consumer_0) ObjectRegistry.register(__smrt_consumer_0, { name: "SharedThing", packageName: "@test/pkg", _manifest: smrtRegistrationManifests["@test/pkg:SharedThing"], _manifestKey: "@test/pkg:SharedThing" });',
    );
    expect(content).toContain(
      'if (__smrt_consumer_1) ObjectRegistry.register(__smrt_consumer_1, { name: "SharedThing", packageName: "@test/other", _manifest: smrtRegistrationManifests["@test/other:SharedThing"], _manifestKey: "@test/other:SharedThing" });',
    );

    const manifestLiteral = content.match(
      /const smrtRegistrationManifests = JSON\.parse\((.+)\);/,
    )?.[1];
    const registrationManifests = JSON.parse(
      JSON.parse(manifestLiteral as string),
    );
    expect(
      registrationManifests['@test/pkg:SharedThing'].objects[
        '@test/pkg:SharedThing'
      ].fields,
    ).toEqual({ alpha: { type: 'string' } });
    expect(
      registrationManifests['@test/other:SharedThing'].objects[
        '@test/other:SharedThing'
      ].fields,
    ).toEqual({ beta: { type: 'number' } });
  });

  it('preserves local project entries already in .smrt/manifest.json (issue #1760 review)', async () => {
    // smrtPlugin() writes the project's own scanned objects to
    // .smrt/manifest.json; both plugins write in parallel buildStart hooks,
    // so the consumer's aggregated write must merge, not clobber — otherwise
    // local field metadata vanishes and server writes drop domain columns.
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    writeFileSync(
      join(smrtDir, 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        timestamp: 1,
        packageName: 'consumer-app',
        objects: {
          'consumer-app:Item': {
            className: 'Item',
            qualifiedName: 'consumer-app:Item',
            packageName: 'consumer-app',
            collection: 'items',
            fields: { title: { type: 'text' } },
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await plugin.buildStart?.call({} as any);

    const merged = JSON.parse(
      readFileSync(join(smrtDir, 'manifest.json'), 'utf-8'),
    );

    // Local entry survives with its field metadata intact.
    expect(merged.objects['consumer-app:Item']).toBeDefined();
    expect(merged.objects['consumer-app:Item'].fields.title.type).toBe('text');
    // Aggregated external entries are added alongside it.
    expect(merged.objects.ExternalThing).toBeDefined();
    // The local project's packageName remains the manifest cache key.
    expect(merged.packageName).toBe('consumer-app');
  });
});
