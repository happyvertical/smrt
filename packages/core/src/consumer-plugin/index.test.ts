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
      'ObjectRegistry.register(ExternalThing, { name: "ExternalThing", packageName: "@test/pkg" });',
    );
    expect(content).toContain(
      "console.log('[smrt:register] Registered 1 external object');",
    );
    expect(content).toContain(
      "import { ExternalThingCollection } from '@test/pkg';",
    );
    expect(content).toContain(
      "import { LegacyThingCollection } from '@test/pkg';",
    );
    expect(content).toContain(
      "import { SpecializedThingCollection } from '@test/pkg';",
    );
    expect(content).not.toContain(
      'ObjectRegistry.register(ExternalThingCollection',
    );
    expect(content).not.toContain(
      'ObjectRegistry.register(LegacyThingCollection',
    );
    expect(content).not.toContain(
      'ObjectRegistry.register(SpecializedThingCollection',
    );
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
