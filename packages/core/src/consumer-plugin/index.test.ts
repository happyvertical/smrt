import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { OxcScanner } from '@happyvertical/smrt-scanner';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin } from 'vite';
import { build } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smrtPlugin } from '../vite-plugin/index.js';
import {
  type ArtifactFilesystem,
  publishArtifactFiles,
  publishAtomicArtifact,
} from './artifact-publication.js';
import { smrtConsumer } from './index';

function buildStart(plugin: Plugin, context: unknown): Promise<void> {
  const hook = plugin.buildStart;
  if (!hook) throw new Error('Expected buildStart hook');
  const handler = typeof hook === 'function' ? hook : hook.handler;
  return Promise.resolve(
    handler.call(
      context as ThisParameterType<typeof handler>,
      {} as Parameters<typeof handler>[0],
    ),
  );
}

function configResolved(
  plugin: Plugin,
  context: unknown,
  config: unknown,
): Promise<void> {
  const hook = plugin.configResolved;
  if (!hook) throw new Error('Expected configResolved hook');
  const handler = typeof hook === 'function' ? hook : hook.handler;
  return Promise.resolve(
    handler.call(
      context as ThisParameterType<typeof handler>,
      config as Parameters<typeof handler>[0],
    ),
  );
}

function manifestHash(manifest: unknown): string {
  const { timestamp: _timestamp, ...withoutTimestamp } = manifest as Record<
    string,
    unknown
  >;
  return createHash('sha256')
    .update(JSON.stringify(sortJson(withoutTimestamp), null, 2))
    .digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

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
        name: '@fixture/consumer-app',
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

  it('keeps consumer providers and their SMRT runtime closure external during SSR', async () => {
    const providerDir = join(tmpDir, 'node_modules', '@test', 'pkg');
    const coreDir = join(tmpDir, 'node_modules', '@happyvertical', 'smrt-core');
    const tenancyDir = join(
      tmpDir,
      'node_modules',
      '@happyvertical',
      'smrt-tenancy',
    );
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(tenancyDir, { recursive: true });
    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        dependencies: { '@happyvertical/smrt-core': '1.0.0' },
      }),
    );
    writeFileSync(
      join(coreDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-core',
        dependencies: { '@happyvertical/smrt-tenancy': '1.0.0' },
      }),
    );
    writeFileSync(
      join(tenancyDir, 'package.json'),
      JSON.stringify({ name: '@happyvertical/smrt-tenancy' }),
    );

    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const configHook = plugin.config;
    const config = await (typeof configHook === 'function'
      ? configHook.call({} as any, {} as any, {
          command: 'build',
          mode: 'production',
        })
      : configHook?.handler.call({} as any, {} as any, {
          command: 'build',
          mode: 'production',
        }));
    const external = (config as any).build.rollupOptions.external as RegExp[];
    expect(external).toHaveLength(1);
    expect(external[0].test('/tmp/provider/native-addon.node')).toBe(true);
    expect(external[0].test('/tmp/provider/index.js')).toBe(false);
    expect((config as any).ssr.external).toEqual([
      '@happyvertical/smrt-core',
      '@happyvertical/smrt-tenancy',
      '@test/pkg',
    ]);
  });

  it('resolves hoisted providers and their SMRT runtime closure from the project context', async () => {
    const appRoot = join(tmpDir, 'apps', 'consumer');
    const providerDir = join(tmpDir, 'node_modules', '@test', 'pkg');
    const coreDir = join(tmpDir, 'node_modules', '@happyvertical', 'smrt-core');
    const tenancyDir = join(
      tmpDir,
      'node_modules',
      '@happyvertical',
      'smrt-tenancy',
    );
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(tenancyDir, { recursive: true });
    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        version: '1.2.3',
        exports: { '.': './dist/index.js' },
        dependencies: { '@happyvertical/smrt-core': '1.0.0' },
      }),
    );
    writeFileSync(
      join(coreDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-core',
        dependencies: { '@happyvertical/smrt-tenancy': '1.0.0' },
      }),
    );
    writeFileSync(
      join(tenancyDir, 'package.json'),
      JSON.stringify({ name: '@happyvertical/smrt-tenancy' }),
    );

    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      projectRoot: appRoot,
      disableScanning: true,
      generateTypes: false,
    });
    const configHook = plugin.config;
    const config = await (typeof configHook === 'function'
      ? configHook.call({} as any, {} as any, {
          command: 'build',
          mode: 'production',
        })
      : configHook?.handler.call({} as any, {} as any, {
          command: 'build',
          mode: 'production',
        }));

    expect((config as any).ssr.external).toEqual([
      '@happyvertical/smrt-core',
      '@happyvertical/smrt-tenancy',
      '@test/pkg',
    ]);
    await buildStart(plugin, {} as any);
    expect(readFileSync(join(appRoot, '.smrt/register.js'), 'utf8')).toContain(
      "import * as __smrt_provider_0 from '@test/pkg';",
    );
  });

  it('follows nested-only SMRT dependencies from each owning package context', async () => {
    const providerDir = join(tmpDir, 'node_modules', '@test', 'pkg');
    const bridgeDir = join(
      providerDir,
      'node_modules',
      '@happyvertical',
      'smrt-bridge',
    );
    const contextDir = join(
      bridgeDir,
      'node_modules',
      '@happyvertical',
      'smrt-context',
    );
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        dependencies: { '@happyvertical/smrt-bridge': '1.0.0' },
      }),
    );
    writeFileSync(
      join(bridgeDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-bridge',
        dependencies: {
          '@happyvertical/smrt-context': '1.0.0',
          '@happyvertical/smrt-app-runtime': '1.0.0',
        },
      }),
    );
    writeFileSync(
      join(contextDir, 'package.json'),
      JSON.stringify({ name: '@happyvertical/smrt-context' }),
    );

    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const configHook = plugin.config;
    const config = await (typeof configHook === 'function'
      ? configHook.call({} as any, {} as any, {
          command: 'build',
          mode: 'production',
        })
      : configHook?.handler.call({} as any, {} as any, {
          command: 'build',
          mode: 'production',
        }));

    expect(
      existsSync(join(tmpDir, 'node_modules', '@happyvertical', 'smrt-bridge')),
    ).toBe(false);
    expect(
      existsSync(
        join(tmpDir, 'node_modules', '@happyvertical', 'smrt-context'),
      ),
    ).toBe(false);
    expect((config as any).ssr.external).toEqual(['@test/pkg']);
  });

  it('runs a native-backed provider from its pnpm package context without splitting core or tenancy', async () => {
    const providerDir = join(tmpDir, 'node_modules', '@test', 'pkg');
    const coreDir = join(tmpDir, 'node_modules', '@happyvertical', 'smrt-core');
    const tenancyDir = join(
      tmpDir,
      'node_modules',
      '@happyvertical',
      'smrt-tenancy',
    );
    const nativeDir = join(providerDir, 'node_modules', 'native-image-payload');
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(tenancyDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        type: 'module',
        exports: './index.js',
        dependencies: { '@happyvertical/smrt-core': '1.0.0' },
      }),
    );
    writeFileSync(
      join(providerDir, 'index.js'),
      [
        "import { createRequire } from 'node:module';",
        "import { registry } from '@happyvertical/smrt-core';",
        "import { tenantContext } from '@happyvertical/smrt-tenancy';",
        'const require = createRequire(import.meta.url);',
        "export const imagePayload = require('native-image-payload');",
        'export const providerRegistry = registry;',
        'export const providerTenantContext = tenantContext;',
      ].join('\n'),
    );
    writeFileSync(
      join(coreDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-core',
        type: 'module',
        exports: './index.js',
        dependencies: { '@happyvertical/smrt-tenancy': '1.0.0' },
      }),
    );
    writeFileSync(join(coreDir, 'index.js'), 'export const registry = {};\n');
    writeFileSync(
      join(tenancyDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-tenancy',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(tenancyDir, 'index.js'),
      "import { AsyncLocalStorage } from 'node:async_hooks';\nexport const tenantContext = new AsyncLocalStorage();\n",
    );
    writeFileSync(
      join(nativeDir, 'package.json'),
      JSON.stringify({ name: 'native-image-payload', main: './index.cjs' }),
    );
    writeFileSync(
      join(nativeDir, 'index.cjs'),
      "module.exports = 'tiny-image';\n",
    );
    writeFileSync(
      join(tmpDir, 'src', 'entry.ts'),
      [
        "import { registry } from '@happyvertical/smrt-core';",
        "import { tenantContext } from '@happyvertical/smrt-tenancy';",
        "import { imagePayload, providerRegistry, providerTenantContext } from '@test/pkg';",
        'console.log(JSON.stringify({',
        '  imagePayload,',
        '  registry: registry === providerRegistry,',
        '  tenancy: tenantContext === providerTenantContext,',
        '}));',
      ].join('\n'),
    );

    await build({
      root: tmpDir,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        smrtConsumer({
          packages: ['@test/pkg'],
          projectRoot: tmpDir,
          disableScanning: true,
          generateTypes: false,
        }),
      ],
      ssr: { noExternal: true },
      build: {
        ssr: join(tmpDir, 'src', 'entry.ts'),
        outDir: join(tmpDir, 'server'),
        emptyOutDir: true,
        rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
      },
    });

    const entry = join(tmpDir, 'server', 'entry.mjs');
    const output = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
    });
    expect(output.status, output.stderr).toBe(0);
    expect(output.stderr).toBe('');
    expect(JSON.parse(output.stdout)).toEqual({
      imagePayload: 'tiny-image',
      registry: true,
      tenancy: true,
    });
    expect(readFileSync(entry, 'utf8')).toMatch(/from ["']@test\/pkg["']/);
  });

  it('splits mixed native server and Svelte exports at the SSR boundary', async () => {
    const providerDir = join(tmpDir, 'node_modules', '@test', 'pkg');
    const typesDir = join(
      providerDir,
      'node_modules',
      '@happyvertical',
      'smrt-types',
    );
    const modelDir = join(
      providerDir,
      'node_modules',
      '@happyvertical',
      'smrt-model',
    );
    const appModelDir = join(
      tmpDir,
      'node_modules',
      '@happyvertical',
      'smrt-model',
    );
    const coreDir = join(tmpDir, 'node_modules', '@happyvertical', 'smrt-core');
    const nativeDir = join(providerDir, 'node_modules', 'native-image-payload');
    mkdirSync(typesDir, { recursive: true });
    mkdirSync(modelDir, { recursive: true });
    mkdirSync(appModelDir, { recursive: true });
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    mkdirSync(join(providerDir, 'themes'), { recursive: true });
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        type: 'module',
        exports: {
          '.': { import: './server.js' },
          './server': { import: './server.js' },
          './themes': {
            svelte: './themes/index.js',
            import: './themes/index.js',
            default: './themes/index.js',
          },
        },
        dependencies: {
          '@happyvertical/smrt-core': '1.0.0',
          '@happyvertical/smrt-model': '1.0.0',
          '@happyvertical/smrt-types': '1.0.0',
          'native-image-payload': '1.0.0',
        },
      }),
    );
    writeFileSync(
      join(providerDir, 'server.js'),
      [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        "export const imagePayload = require('native-image-payload');",
        'export const loadModelConstructors = async () => {',
        "  const model = await import('@happyvertical/smrt-model');",
        '  return [model.NestedModel, model.NestedModelCollection];',
        '};',
      ].join('\n'),
    );
    writeFileSync(
      join(providerDir, 'dist', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/pkg',
        objects: {
          NestedModel: {
            className: 'NestedModel',
            packageName: '@happyvertical/smrt-model',
            importPath: '@happyvertical/smrt-model',
            hasCollection: true,
            collectionExportName: 'NestedModelCollection',
            collection: 'nested_models',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    writeFileSync(
      join(providerDir, 'Component.svelte'),
      [
        '<script>',
        "  import { marker } from '@happyvertical/smrt-types';",
        "  export let label = 'missing';",
        '</script>',
        '<p>{label}:{marker}</p>',
      ].join('\n'),
    );
    writeFileSync(
      join(providerDir, 'themes', 'index.js'),
      "export { default } from '../Component.svelte';\n",
    );
    writeFileSync(
      join(typesDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-types',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(typesDir, 'index.js'),
      "export const marker = 'types';\n",
    );
    writeFileSync(
      join(coreDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-core',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(coreDir, 'index.js'),
      [
        'const classes = globalThis.__fixtureSmrtClasses ??= new Map();',
        'const collections = globalThis.__fixtureSmrtCollections ??= new Map();',
        'export const ObjectRegistry = {',
        "  register(ctor, config) { const qualifiedName = config.packageName + ':' + config.name; classes.set(qualifiedName, { constructor: ctor, name: config.name, qualifiedName }); },",
        "  getClassInPackage(packageName, name) { return classes.get(packageName + ':' + name); },",
        '  registerCollection(name, ctor) { const entry = classes.get(name) ?? [...classes.values()].find((candidate) => candidate.name === name); if (entry) entry.collectionConstructor = ctor; collections.set(name, ctor); },',
        '  async getCollection(name) { const entry = classes.get(name) ?? [...classes.values()].find((candidate) => candidate.name === name); const ctor = entry?.collectionConstructor ?? collections.get(name) ?? class DefaultCollection {}; return new ctor(); },',
        '};',
      ].join('\n'),
    );
    writeFileSync(
      join(modelDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-model',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(modelDir, 'index.js'),
      [
        "import { ObjectRegistry } from '@happyvertical/smrt-core';",
        'export class NestedModel {}',
        'export class NestedModelCollection {}',
        'NestedModelCollection._itemClass = NestedModel;',
        "ObjectRegistry.register(NestedModel, { name: 'NestedModel', packageName: '@happyvertical/smrt-model' });",
      ].join('\n'),
    );
    writeFileSync(
      join(appModelDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-model',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(appModelDir, 'index.js'),
      [
        "import { ObjectRegistry } from '@happyvertical/smrt-core';",
        'export class NestedModel {}',
        'export class NestedModelCollection {}',
        'NestedModelCollection._itemClass = NestedModel;',
        "ObjectRegistry.register(NestedModel, { name: 'NestedModel', packageName: '@happyvertical/smrt-model' });",
      ].join('\n'),
    );
    writeFileSync(
      join(nativeDir, 'package.json'),
      JSON.stringify({ name: 'native-image-payload', main: './index.cjs' }),
    );
    writeFileSync(
      join(nativeDir, 'index.cjs'),
      "module.exports = 'native-server';\n",
    );
    writeFileSync(
      join(tmpDir, 'src', 'svelte-entry.ts'),
      [
        "import '../.smrt/register.js';",
        "import { ObjectRegistry } from '@happyvertical/smrt-core';",
        "import { imagePayload, loadModelConstructors } from '@test/pkg/server';",
        "import Widget from '@test/pkg/themes';",
        "import { render } from 'svelte/server';",
        "const registeredModel = ObjectRegistry.getClassInPackage('@happyvertical/smrt-model', 'NestedModel')?.constructor;",
        "const registeredCollection = (await ObjectRegistry.getCollection('@happyvertical/smrt-model:NestedModel')).constructor;",
        'const [providerModel, providerCollection] = await loadModelConstructors();',
        "console.log(JSON.stringify({ imagePayload, modelIdentity: registeredModel === providerModel, collectionIdentity: registeredCollection === providerCollection, html: render(Widget, { props: { label: 'compiled' } }).body }));",
      ].join('\n'),
    );

    await build({
      root: tmpDir,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        svelte(),
        smrtConsumer({
          packages: ['@test/pkg'],
          projectRoot: tmpDir,
          disableScanning: true,
          generateTypes: false,
        }),
      ],
      ssr: { noExternal: true },
      build: {
        ssr: join(tmpDir, 'src', 'svelte-entry.ts'),
        outDir: join(tmpDir, 'svelte-server'),
        emptyOutDir: true,
        rollupOptions: { output: { entryFileNames: 'entry.mjs' } },
      },
    });

    const entry = join(tmpDir, 'svelte-server', 'entry.mjs');
    const content = readFileSync(entry, 'utf8');
    const relocated = join(tmpDir, 'relocated');
    mkdirSync(relocated);
    fs.cpSync(join(tmpDir, 'svelte-server'), join(relocated, 'server'), {
      recursive: true,
    });
    fs.cpSync(join(tmpDir, 'node_modules'), join(relocated, 'node_modules'), {
      recursive: true,
    });
    writeFileSync(
      join(relocated, 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    const output = spawnSync(
      process.execPath,
      [join(relocated, 'server', 'entry.mjs')],
      { encoding: 'utf8', cwd: relocated },
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      imagePayload: 'native-server',
      modelIdentity: true,
      collectionIdentity: true,
    });
    expect(JSON.parse(output.stdout).html).toContain('<p>compiled:types</p>');
    expect(content).toMatch(/from ["']@test\/pkg\/server["']/);
    expect(content).not.toMatch(/from ["']@test\/pkg\/themes["']/);
    expect(content).not.toMatch(/from ["']@happyvertical\/smrt-model["']/);
    expect(content).not.toMatch(/from ["']@happyvertical\/smrt-types["']/);
  });

  it('rejects one qualified object contributed by distinct provider graphs', async () => {
    for (const provider of ['a', 'b']) {
      const providerDir = join(tmpDir, 'node_modules', '@test', provider);
      const modelDir = join(providerDir, 'node_modules', '@nested', 'model');
      mkdirSync(join(providerDir, 'dist'), { recursive: true });
      mkdirSync(modelDir, { recursive: true });
      writeFileSync(
        join(providerDir, 'package.json'),
        JSON.stringify({ name: `@test/${provider}`, type: 'module' }),
      );
      writeFileSync(
        join(modelDir, 'package.json'),
        JSON.stringify({ name: '@nested/model', type: 'module' }),
      );
      writeFileSync(
        join(providerDir, 'dist', 'manifest.json'),
        JSON.stringify({
          packageName: `@test/${provider}`,
          objects: {
            '@nested/model:Shared': {
              className: 'Shared',
              packageName: '@nested/model',
              importPath: '@nested/model',
              fields: {},
              methods: {},
              decoratorConfig: {},
            },
          },
        }),
      );
    }

    const plugin = smrtConsumer({
      packages: ['@test/a', '@test/b'],
      projectRoot: tmpDir,
      disableScanning: true,
      generateTypes: false,
    });
    await expect(buildStart(plugin, {} as any)).rejects.toThrow(
      'contributed by multiple installed provider graphs',
    );
  });

  it('still bundles providers in browser and component-library builds', async () => {
    const providerDir = join(tmpDir, 'node_modules', '@test', 'pkg');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        name: '@test/pkg',
        type: 'module',
        exports: './index.js',
      }),
    );
    writeFileSync(
      join(providerDir, 'index.js'),
      "export const marker = 'browser-provider-marker';\n",
    );
    writeFileSync(
      join(tmpDir, 'src', 'component.ts'),
      "export { marker } from '@test/pkg';\n",
    );

    await build({
      root: tmpDir,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        smrtConsumer({
          packages: ['@test/pkg'],
          projectRoot: tmpDir,
          disableScanning: true,
          generateTypes: false,
        }),
      ],
      build: {
        lib: {
          entry: join(tmpDir, 'src', 'component.ts'),
          formats: ['es'],
          fileName: 'component',
        },
        outDir: join(tmpDir, 'client'),
        emptyOutDir: true,
      },
    });

    const [outputFile] = readdirSync(join(tmpDir, 'client'));
    expect(outputFile).toBeDefined();
    const output = readFileSync(
      join(tmpDir, 'client', outputFile as string),
      'utf8',
    );
    expect(output).toContain('browser-provider-marker');
    expect(output).not.toMatch(/from ["']@test\/pkg["']/);
  });

  it('should write explicit package names into .smrt/register.js', async () => {
    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(plugin, {} as any);

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
    await buildStart(plugin, {} as any);

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
        packageName: '@fixture/consumer-app',
        objects: {
          '@fixture/consumer-app:Item': {
            className: 'Item',
            qualifiedName: '@fixture/consumer-app:Item',
            packageName: '@fixture/consumer-app',
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

    await buildStart(plugin, {} as any);

    const merged = JSON.parse(
      readFileSync(join(smrtDir, 'manifest.json'), 'utf-8'),
    );

    // Local entry survives with its field metadata intact.
    expect(merged.objects['@fixture/consumer-app:Item']).toBeDefined();
    expect(merged.objects['@fixture/consumer-app:Item'].fields.title.type).toBe(
      'text',
    );
    // Aggregated external entries are added alongside it.
    expect(merged.objects.ExternalThing).toBeDefined();
    // The local project's packageName remains the manifest cache key.
    expect(merged.packageName).toBe('@fixture/consumer-app');

    const knowledge = JSON.parse(
      readFileSync(join(smrtDir, 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge.sourceHashes.manifest).toBe(manifestHash(merged));
    expect(knowledge.objects).toContainEqual(
      expect.objectContaining({ name: 'ExternalThing' }),
    );
  });

  it('uses inline producer knowledge options when refreshing consumer knowledge', async () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({
        knowledge: {
          includeDocs: true,
          includePrompts: true,
          tags: ['file-tag'],
          summary: 'file summary',
          risks: ['file risk'],
        },
        packages: {
          '@fixture/consumer-app': { knowledge: { tags: ['package-tag'] } },
        },
      }),
    );
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Consumer instructions');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src', 'prompt.ts'),
      "definePrompt('consumer-prompt', {});",
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const producer = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
      knowledge: {
        includeDocs: false,
        includePrompts: false,
        tags: ['inline-tag'],
        summary: 'inline summary',
        risks: ['inline risk'],
      },
    });
    const resolvedConfig = {
      root: tmpDir,
      build: {},
      plugins: [producer, consumer],
    };
    await configResolved(producer, producer, resolvedConfig as any);
    await configResolved(consumer, consumer, resolvedConfig as any);

    await buildStart(consumer, {} as any);

    const knowledge = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge).toMatchObject({
      tags: ['inline-tag'],
      summary: 'inline summary',
      risks: ['inline risk'],
      prompts: [],
    });
    expect(knowledge.agentDoc).toBeUndefined();
  });

  it('does not regenerate knowledge when inline producer options disable it', async () => {
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const producer = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
      knowledge: { enabled: false },
    });
    const resolvedConfig = {
      root: tmpDir,
      build: {},
      plugins: [producer, consumer],
    };
    await configResolved(producer, producer, resolvedConfig as any);
    const knowledgePath = join(tmpDir, '.smrt', 'smrt-knowledge.json');
    writeFileSync(knowledgePath, '{"previous":"artifact"}');
    await configResolved(consumer, consumer, resolvedConfig as any);

    await buildStart(consumer, {} as any);

    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"artifact"}',
    );
  });

  it('uses the current producer scan after an intent changes at the same path', async () => {
    const sourcePath = join(tmpDir, 'src', 'orders.intents.ts');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      sourcePath,
      `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const orders = defineIntent({
  id: 'orders.previous',
  description: 'Previous declaration',
  target: { registry: 'dataSurface', controlId: 'orders', kind: 'table' },
});`,
    );
    const objectPath = join(tmpDir, 'src', 'order.ts');
    writeFileSync(
      objectPath,
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt()
export class PreviousOrder extends SmrtObject {
  status = '';
}`,
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });
    const producer = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    const resolvedConfig = {
      root: tmpDir,
      build: {},
      plugins: [producer, consumer],
    };
    await configResolved(producer, producer, resolvedConfig as any);
    await configResolved(consumer, consumer, resolvedConfig as any);
    // The first buildStart reuses configResolved's scan. The next one is the
    // watch-style refresh that can run in parallel with the consumer.
    await buildStart(producer, producer);

    writeFileSync(
      sourcePath,
      `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const orders = defineIntent({
  id: 'orders.current',
  description: 'Current declaration',
  target: { registry: 'dataSurface', controlId: 'orders', kind: 'table' },
});`,
    );
    writeFileSync(
      objectPath,
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt()
export class CurrentOrder extends SmrtObject {
  status = '';
}`,
    );
    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const originalScan = OxcScanner.prototype.scanAndResolve;
    const delayedScan = vi
      .spyOn(OxcScanner.prototype, 'scanAndResolve')
      .mockImplementation(async function (this: OxcScanner, ...args) {
        await scanGate;
        return originalScan.apply(this, args);
      });
    try {
      const producerRefresh = buildStart(producer, producer);
      // Give the producer hook its synchronous turn to register its in-flight
      // scan, then start the consumer while that scan remains blocked.
      await Promise.resolve();
      let consumerComplete = false;
      const consumerRefresh = buildStart(consumer, consumer).then(() => {
        consumerComplete = true;
      });
      await Promise.resolve();
      expect(consumerComplete).toBe(false);
      releaseScan?.();
      await Promise.all([producerRefresh, consumerRefresh]);
    } finally {
      delayedScan.mockRestore();
      releaseScan?.();
    }

    const knowledge = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge.agentSurface.intents).toEqual([
      expect.objectContaining({
        id: 'orders.current',
        description: 'Current declaration',
        sourceFile: 'src/orders.intents.ts',
      }),
    ]);
    expect(
      knowledge.sourceHashes['agentSurface:src/orders.intents.ts'],
    ).toBeDefined();
    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(
      manifest.objects['@fixture/consumer-app:CurrentOrder'],
    ).toBeDefined();
    expect(
      manifest.objects['@fixture/consumer-app:PreviousOrder'],
    ).toBeUndefined();
  });

  it('does not rehash a prior artifact agent surface without a producer', async () => {
    const knowledgePath = join(tmpDir, '.smrt', 'smrt-knowledge.json');
    mkdirSync(join(tmpDir, '.smrt'), { recursive: true });
    writeFileSync(
      knowledgePath,
      JSON.stringify({
        agentSurface: {
          intents: [
            {
              id: 'orders.stale',
              description: 'Stale declaration',
              sourceFile: 'src/orders.intents.ts',
            },
          ],
          playbooks: [],
          diagnostics: [],
        },
      }),
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(consumer, consumer);

    const knowledge = JSON.parse(readFileSync(knowledgePath, 'utf-8'));
    expect(knowledge.agentSurface).toBeUndefined();
    expect(knowledge.sourceHashes).not.toHaveProperty(
      'agentSurface:src/orders.intents.ts',
    );
  });

  it('uses file and package knowledge configuration without a producer plugin', async () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({
        knowledge: { enabled: true, includeDocs: false, includePrompts: false },
        packages: {
          '@fixture/consumer-app': { knowledge: { enabled: false } },
        },
      }),
    );
    const knowledgePath = join(tmpDir, '.smrt', 'smrt-knowledge.json');
    mkdirSync(join(tmpDir, '.smrt'), { recursive: true });
    writeFileSync(knowledgePath, '{"previous":"artifact"}');
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(consumer, {} as any);

    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"artifact"}',
    );
  });

  it('restores the previous artifact pair when manifest publication fails', async () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const manifestPath = join(smrtDir, 'manifest.json');
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const previousManifest = JSON.stringify({
      version: '1.0.0',
      timestamp: 1,
      packageName: '@fixture/consumer-app',
      objects: {},
    });
    const previousKnowledge = '{"previous":"knowledge"}';
    writeFileSync(manifestPath, previousManifest);
    writeFileSync(knowledgePath, previousKnowledge);
    let renameCount = 0;
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: (...args) => {
        renameCount++;
        if (renameCount === 4) throw new Error('manifest publication failed');
        return fs.renameSync(...args);
      },
    };
    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('manifest publication failed');

    expect(readFileSync(manifestPath, 'utf-8')).toBe(previousManifest);
    expect(readFileSync(knowledgePath, 'utf-8')).toBe(previousKnowledge);
  });

  it('keeps prior artifacts when staging a later replacement fails', () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const manifestPath = join(smrtDir, 'manifest.json');
    writeFileSync(knowledgePath, '{"previous":"knowledge"}');
    writeFileSync(manifestPath, '{"previous":"manifest"}');
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      chmodSync: fs.chmodSync,
      renameSync: fs.renameSync,
      writeFileSync: (pathname, ...args) => {
        fs.writeFileSync(pathname, ...args);
        if (String(pathname).includes('manifest.json.smrt-')) {
          throw new Error('manifest staging failed');
        }
      },
    };

    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('manifest staging failed');
    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"knowledge"}',
    );
    expect(readFileSync(manifestPath, 'utf-8')).toBe('{"previous":"manifest"}');
    expect(
      readdirSync(smrtDir).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('removes a first-generation replacement when a later publication fails', () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const manifestPath = join(smrtDir, 'manifest.json');
    let renameCount = 0;
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: (...args) => {
        renameCount++;
        if (renameCount === 2) throw new Error('manifest publication failed');
        return fs.renameSync(...args);
      },
    };

    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('manifest publication failed');
    expect(existsSync(knowledgePath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('retains a backup when rollback itself fails', () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(smrtDir, { recursive: true });
    const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
    const manifestPath = join(smrtDir, 'manifest.json');
    writeFileSync(knowledgePath, '{"previous":"knowledge"}');
    writeFileSync(manifestPath, '{"previous":"manifest"}');
    let renameCount = 0;
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: (...args) => {
        renameCount++;
        if (renameCount === 4 || renameCount === 5) {
          throw new Error('publication or rollback failed');
        }
        return fs.renameSync(...args);
      },
    };

    expect(() =>
      publishArtifactFiles(
        [
          { path: knowledgePath, content: '{"next":"knowledge"}' },
          { path: manifestPath, content: '{"next":"manifest"}' },
        ],
        filesystem,
      ),
    ).toThrow('rollback retained recovery backups');
    const manifestBackup = readdirSync(smrtDir).find((entry) =>
      entry.startsWith('manifest.json.smrt-'),
    );
    expect(manifestBackup).toBeDefined();
    if (!manifestBackup) throw new Error('Expected retained manifest backup');
    expect(readFileSync(join(smrtDir, manifestBackup), 'utf-8')).toBe(
      '{"previous":"manifest"}',
    );
    expect(readFileSync(knowledgePath, 'utf-8')).toBe(
      '{"previous":"knowledge"}',
    );
  });

  it('atomically replaces one artifact without a reader-visible missing path', () => {
    const path = join(tmpDir, 'knowledge.json');
    writeFileSync(path, 'before', { mode: 0o640 });
    const reads: string[] = [];
    const filesystem: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: (...args) => {
        reads.push(readFileSync(path, 'utf8'));
        return fs.renameSync(...args);
      },
    };
    publishAtomicArtifact({ path, content: 'after' }, filesystem);
    expect(reads).toEqual(['before']);
    expect(readFileSync(path, 'utf8')).toBe('after');
    expect(fs.statSync(path).mode & 0o777).toBe(0o640);
  });

  it('keeps the old artifact when atomic staging or replacement fails', () => {
    const path = join(tmpDir, 'knowledge.json');
    writeFileSync(path, 'before');
    const failRename: ArtifactFilesystem = {
      existsSync,
      statSync: fs.statSync,
      unlinkSync: fs.unlinkSync,
      writeFileSync,
      chmodSync: fs.chmodSync,
      renameSync: () => {
        throw new Error('rename failed');
      },
    };
    expect(() =>
      publishAtomicArtifact({ path, content: 'after' }, failRename),
    ).toThrow('rename failed');
    expect(readFileSync(path, 'utf8')).toBe('before');
  });

  it('excludes standalone consumer docs and prompts from file configuration', async () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({
        knowledge: { includeDocs: false, includePrompts: false },
      }),
    );
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Consumer instructions');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src', 'prompt.ts'),
      "definePrompt('prompt', {})",
    );
    const consumer = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(consumer, {} as any);

    const knowledge = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(knowledge.agentDoc).toBeUndefined();
    expect(knowledge.prompts).toEqual([]);
  });

  it('fails aggregation without publishing a new manifest when knowledge cannot be written', async () => {
    const smrtDir = join(tmpDir, '.smrt');
    mkdirSync(join(smrtDir, 'smrt-knowledge.json'), { recursive: true });
    writeFileSync(
      join(smrtDir, 'manifest.json'),
      JSON.stringify({ version: '1.0.0', timestamp: 1, objects: {} }),
    );
    const before = readFileSync(join(smrtDir, 'manifest.json'), 'utf-8');
    const plugin = smrtConsumer({
      packages: ['@test/pkg'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await expect(buildStart(plugin, {} as any)).rejects.toThrow(
      'Failed to save aggregated manifest',
    );
    expect(readFileSync(join(smrtDir, 'manifest.json'), 'utf-8')).toBe(before);
  });
});

/**
 * Issue #2923: a consumed package declares where its manifest lives through
 * its own `package.json#exports` map (the repo's own model-package contract,
 * enforced by `manifest/__tests__/workspace-package-manifest-exports.test.ts`).
 * Probing only this framework's conventional paths skipped any package that
 * builds elsewhere — `@happyvertical/smrt-products` maps
 * `"./manifest.json": "./dist/lib/manifest.json"` — and did so with no log
 * line at all, so the package simply contributed zero objects.
 */
describe('smrtConsumer manifest resolution through package exports', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function writeConsumerProject(dependencies: Record<string, string> = {}) {
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/consumer-app',
        version: '1.0.0',
        dependencies,
      }),
    );
  }

  function writeProviderPackage(options: {
    packageName: string;
    exports?: Record<string, unknown>;
    manifestRelativePath?: string;
    objectName?: string;
  }) {
    const packageDir = join(
      tmpDir,
      'node_modules',
      ...options.packageName.split('/'),
    );
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: options.packageName,
        version: '9.9.9',
        exports: options.exports ?? { '.': './dist/lib/index.js' },
      }),
    );

    if (options.manifestRelativePath) {
      const manifestPath = join(packageDir, options.manifestRelativePath);
      mkdirSync(join(manifestPath, '..'), { recursive: true });
      const objectName = options.objectName ?? 'Product';
      writeFileSync(
        manifestPath,
        JSON.stringify({
          moduleType: 'smrt',
          packageName: options.packageName,
          objects: {
            [objectName]: {
              className: objectName,
              collection: 'products',
              fields: {},
              methods: {},
              decoratorConfig: {},
            },
          },
        }),
      );
    }

    return packageDir;
  }

  beforeEach(() => {
    tmpDir = resolve(
      import.meta.dirname,
      `__test-consumer-exports-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    writeConsumerProject();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loads a manifest published only through the exports map', async () => {
    writeProviderPackage({
      packageName: '@test/exported',
      exports: {
        '.': './dist/lib/index.js',
        './manifest': './dist/lib/manifest.json',
        './manifest.json': './dist/lib/manifest.json',
      },
      manifestRelativePath: 'dist/lib/manifest.json',
    });

    const plugin = smrtConsumer({
      packages: ['@test/exported'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(plugin, {} as any);

    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(manifest.objects)).toContain('Product');
    expect(manifest.objects.Product).toMatchObject({
      packageName: '@test/exported',
      packageVersion: '9.9.9',
      importPath: '@test/exported',
    });

    const register = readFileSync(
      join(tmpDir, '.smrt', 'register.js'),
      'utf-8',
    );
    expect(register).toContain(
      "import * as __smrt_provider_0 from '@test/exported';",
    );
  });

  it('follows conditional and array export targets', async () => {
    writeProviderPackage({
      packageName: '@test/conditional',
      exports: {
        '.': './dist/lib/index.js',
        './manifest.json': [
          { types: './dist/lib/manifest.d.ts' },
          { default: './dist/lib/manifest.json' },
        ],
      },
      manifestRelativePath: 'dist/lib/manifest.json',
      objectName: 'Sku',
    });

    const plugin = smrtConsumer({
      packages: ['@test/conditional'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(plugin, {} as any);

    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(manifest.objects)).toContain('Sku');
  });

  it('fails the build for an explicitly listed package with no resolvable manifest', async () => {
    writeProviderPackage({
      packageName: '@test/manifestless',
      exports: { '.': './dist/index.js' },
    });

    const plugin = smrtConsumer({
      packages: ['@test/manifestless'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await expect(buildStart(plugin, {} as any)).rejects.toThrow(
      /No SMRT manifest could be resolved for @test\/manifestless/,
    );
    expect(existsSync(join(tmpDir, '.smrt', 'manifest.json'))).toBe(false);
  });

  it('fails the build for an explicitly listed package that is not installed', async () => {
    const plugin = smrtConsumer({
      packages: ['@test/absent'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await expect(buildStart(plugin, {} as any)).rejects.toThrow(
      /No SMRT manifest could be resolved for @test\/absent/,
    );
  });

  it('ignores an exports target that escapes the package directory', async () => {
    mkdirSync(join(tmpDir, 'node_modules', '@test'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'outside-manifest.json'),
      JSON.stringify({
        packageName: '@test/escaping',
        objects: {
          Smuggled: {
            className: 'Smuggled',
            collection: 'smuggled',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    writeProviderPackage({
      packageName: '@test/escaping',
      exports: { './manifest.json': '../outside-manifest.json' },
    });

    const plugin = smrtConsumer({
      packages: ['@test/escaping'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await expect(buildStart(plugin, {} as any)).rejects.toThrow(
      /No SMRT manifest could be resolved for @test\/escaping/,
    );
  });

  it('ignores an exported target that is a symlink out of the package', async () => {
    // The containment check must hold against links, not just `../`: the
    // resolved file is read, parsed, and for `.js` targets imported by the
    // consumer build (PR #2927 review).
    mkdirSync(join(tmpDir, 'node_modules', '@test'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'node_modules', '@test', 'linked-manifest.json'),
      JSON.stringify({
        packageName: '@test/symlinked',
        objects: {
          Smuggled: {
            className: 'Smuggled',
            collection: 'smuggled',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    const packageDir = writeProviderPackage({
      packageName: '@test/symlinked',
      exports: { './manifest.json': './dist/lib/manifest.json' },
    });
    mkdirSync(join(packageDir, 'dist', 'lib'), { recursive: true });
    symlinkSync(
      join(tmpDir, 'node_modules', '@test', 'linked-manifest.json'),
      join(packageDir, 'dist', 'lib', 'manifest.json'),
    );

    const plugin = smrtConsumer({
      packages: ['@test/symlinked'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await expect(buildStart(plugin, {} as any)).rejects.toThrow(
      /No SMRT manifest could be resolved for @test\/symlinked/,
    );
  });

  it('loads an exported manifest reached through a symlinked package root', async () => {
    // pnpm and workspace installs reach a package through a symlink, so the
    // real-path containment check must compare real paths on BOTH sides.
    const realDir = join(tmpDir, 'store', 'real-pkg');
    mkdirSync(join(realDir, 'dist', 'lib'), { recursive: true });
    writeFileSync(
      join(realDir, 'package.json'),
      JSON.stringify({
        name: '@test/linked-root',
        version: '9.9.9',
        exports: { './manifest.json': './dist/lib/manifest.json' },
      }),
    );
    writeFileSync(
      join(realDir, 'dist', 'lib', 'manifest.json'),
      JSON.stringify({
        packageName: '@test/linked-root',
        objects: {
          Material: {
            className: 'Material',
            collection: 'materials',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    mkdirSync(join(tmpDir, 'node_modules', '@test'), { recursive: true });
    symlinkSync(realDir, join(tmpDir, 'node_modules', '@test', 'linked-root'));

    const plugin = smrtConsumer({
      packages: ['@test/linked-root'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(plugin, {} as any);

    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(manifest.objects)).toContain('Material');
  });

  it('falls back to a conventional path when an exported target is malformed', async () => {
    // Export candidates are probed first, so a stale or malformed exported
    // target must not take away the conventional fallback (PR #2927 review).
    const packageDir = writeProviderPackage({
      packageName: '@test/malformed-export',
      exports: { './manifest.json': './dist/lib/manifest.json' },
      manifestRelativePath: 'dist/manifest.json',
      objectName: 'Category',
    });
    mkdirSync(join(packageDir, 'dist', 'lib'), { recursive: true });
    writeFileSync(
      join(packageDir, 'dist', 'lib', 'manifest.json'),
      '{ this is not json',
    );

    const plugin = smrtConsumer({
      packages: ['@test/malformed-export'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(plugin, {} as any);

    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(manifest.objects)).toContain('Category');
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('Could not load manifest candidate'),
      ),
    ).toBe(true);
  });

  it('tries every target of an export array in order', async () => {
    // An export array is a fallback list: a missing first entry must not hide
    // a valid later one (PR #2927 review).
    writeProviderPackage({
      packageName: '@test/array-fallback',
      exports: {
        './manifest.json': [
          './dist/missing-manifest.json',
          './dist/lib/manifest.json',
        ],
      },
      manifestRelativePath: 'dist/lib/manifest.json',
      objectName: 'ProductVariant',
    });

    const plugin = smrtConsumer({
      packages: ['@test/array-fallback'],
      generateTypes: false,
      projectRoot: tmpDir,
      disableScanning: true,
    });

    await buildStart(plugin, {} as any);

    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(manifest.objects)).toContain('ProductVariant');
  });

  it('does not treat an unrelated dependency with a manifest.json as a SMRT package', async () => {
    // `manifest.json` / `dist/manifest.json` are common artifacts of unrelated
    // tooling (Vite build manifests, PWA and extension manifests). Discovery
    // must not announce such a package, warn about it, or read it
    // (PR #2927 final review).
    writeConsumerProject({ 'unrelated-bundler': '1.0.0' });
    const packageDir = writeProviderPackage({
      packageName: 'unrelated-bundler',
      exports: { '.': './dist/index.js' },
    });
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(packageDir, 'dist', 'manifest.json'),
      JSON.stringify({ 'src/main.ts': { file: 'assets/main-abc123.js' } }),
    );
    writeFileSync(
      join(packageDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'Some Extension' }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const plugin = smrtConsumer({
        generateTypes: false,
        projectRoot: tmpDir,
      });

      await buildStart(plugin, {} as any);

      const announced = logSpy.mock.calls.map((call) => String(call[0]));
      expect(
        announced.some(
          (line) =>
            line.includes('Found SMRT packages') &&
            line.includes('unrelated-bundler'),
        ),
      ).toBe(false);

      const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(
        warnings.some((warning) => warning.includes('unrelated-bundler')),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('discovers an unnamed dependency that ships a real SMRT manifest', async () => {
    // The export-aware probe must still recognize a genuine provider whose
    // name carries no `smrt` marker, confirmed by `moduleType: "smrt"`.
    writeConsumerProject({ '@acme/widgets': '1.0.0' });
    const packageDir = writeProviderPackage({
      packageName: '@acme/widgets',
      exports: {
        '.': './dist/lib/index.js',
        './manifest.json': './dist/lib/manifest.json',
      },
    });
    mkdirSync(join(packageDir, 'dist', 'lib'), { recursive: true });
    writeFileSync(
      join(packageDir, 'dist', 'lib', 'manifest.json'),
      JSON.stringify({
        moduleType: 'smrt',
        packageName: '@acme/widgets',
        objects: {
          Widget: {
            className: 'Widget',
            collection: 'widgets',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      generateTypes: false,
      projectRoot: tmpDir,
    });

    await buildStart(plugin, {} as any);

    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(manifest.objects)).toContain('Widget');
  });

  it('warns by name, without failing, for a discovered package with no manifest', async () => {
    writeConsumerProject({ '@test/smrt-discovered': '1.0.0' });
    writeProviderPackage({
      packageName: '@test/smrt-discovered',
      exports: { '.': './dist/index.js' },
    });

    const plugin = smrtConsumer({
      generateTypes: false,
      projectRoot: tmpDir,
    });

    await buildStart(plugin, {} as any);

    const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.some(
        (warning) =>
          warning.includes('No SMRT manifest could be resolved') &&
          warning.includes('@test/smrt-discovered'),
      ),
    ).toBe(true);
  });
});
