/**
 * Tests for the smrtConsumer Vite plugin's pure hooks (src/consumer-plugin/index.ts).
 *
 * The existing index.test.ts covers register.js generation; this file covers
 * the resolveId / load virtual-module hooks and the package-discovery and
 * manifest-aggregation paths in buildStart. We invoke the plugin hook functions
 * directly with synthetic ids / project roots (no Vite dev server, no real
 * build) and assert their pure outputs and on-disk side effects. Temp dirs are
 * removed in afterEach.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  serializeSmrtGenerationSnapshot,
  sha256SmrtGenerationSnapshot,
} from '../generation-snapshot.js';
import { smrtPlugin } from '../vite-plugin/index.js';
import { smrtConsumer } from './index.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-consumer-'));
});

afterEach(() => {
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

function writePackageJson(dir: string, json: Record<string, unknown>) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
}

// resolveId / load are objects-or-functions on the plugin; normalize to a
// callable so we can invoke them with a minimal `this`.
function getHook(plugin: any, name: 'resolveId' | 'load') {
  const hook = plugin[name];
  return typeof hook === 'function' ? hook : hook.handler;
}

describe('smrtConsumer resolveId', () => {
  it('resolves a known virtual module to the \\0 consumer virtual id when no .d.ts exists', () => {
    const plugin = smrtConsumer({
      packages: [],
      projectRoot,
      disableScanning: true,
    });
    const resolveId = getHook(plugin, 'resolveId');

    const resolved = resolveId.call({}, '@smrt/routes', undefined);
    // Namespaced id (#1795): distinct from smrtPlugin's `\0smrt:routes` so the
    // two virtual modules never share a rollup id.
    expect(resolved).toBe('\0smrt-consumer:routes');
    expect(resolveId.call({}, '@smrt/web', undefined)).toBe(
      '\0smrt-consumer:web',
    );
  });

  it('resolves to a DISTINCT virtual id from smrtPlugin so neither shadows the other (#1795)', () => {
    // Regression guard for #1795: smrtPlugin's `@happyvertical/smrt-virt-client`
    // and smrtConsumer's `@smrt/client` used to BOTH resolve to `\0smrt:client`.
    // Sharing that id let the consumer fallback non-deterministically win in
    // standalone/federation builds and shadow the real generated client. The two
    // ids must differ.
    const consumer = smrtConsumer({
      packages: [],
      projectRoot,
      disableScanning: true,
    });
    const producer: any = smrtPlugin();

    const consumerResolve = getHook(consumer, 'resolveId');
    const producerResolveRaw = producer.resolveId;
    const producerResolve =
      typeof producerResolveRaw === 'function'
        ? producerResolveRaw
        : producerResolveRaw.handler;

    const consumerId = consumerResolve.call({}, '@smrt/client', undefined);
    const producerId = producerResolve.call(
      producer,
      '@happyvertical/smrt-virt-client',
    );

    expect(consumerId).toBe('\0smrt-consumer:client');
    expect(producerId).toBe('\0smrt:client');
    expect(consumerId).not.toBe(producerId);
  });

  it('resolves only the type-only module to its physical .d.ts file', () => {
    const typesDir = 'src/types/smrt-generated';
    mkdirSync(join(projectRoot, typesDir), { recursive: true });
    const declPath = join(projectRoot, typesDir, 'smrt-types.d.ts');
    writeFileSync(declPath, '// types');
    writeFileSync(join(projectRoot, typesDir, 'smrt-web.d.ts'), '// web types');

    const plugin = smrtConsumer({
      packages: [],
      typesDir,
      projectRoot,
      disableScanning: true,
    });
    const resolveId = getHook(plugin, 'resolveId');

    const resolved = resolveId.call({}, '@smrt/types', undefined);
    expect(resolved).toBe(declPath);
    expect(resolveId.call({}, '@smrt/client', undefined)).toBe(
      '\0smrt-consumer:client',
    );
    expect(resolveId.call({}, '@smrt/web', undefined)).toBe(
      '\0smrt-consumer:web',
    );
  });

  it('returns null for unknown ids', () => {
    const plugin = smrtConsumer({ projectRoot, disableScanning: true });
    const resolveId = getHook(plugin, 'resolveId');
    expect(resolveId.call({}, 'some-other-module', undefined)).toBeNull();
  });
});

describe('smrtConsumer load fallback modules', () => {
  function makePlugin() {
    return smrtConsumer({ projectRoot, disableScanning: true });
  }

  it('returns a fallback routes module', async () => {
    const load = getHook(makePlugin(), 'load');
    const code = await load.call({}, '\0smrt-consumer:routes');
    expect(code).toContain('export function setupRoutes');
    expect(code).toContain('export default setupRoutes');
  });

  it('returns an empty-client fallback when the manifest has no objects', async () => {
    const load = getHook(makePlugin(), 'load');
    const code = await load.call({}, '\0smrt-consumer:client');
    expect(code).toContain('export function createClient');
    expect(code).toContain('No API client available');
  });

  it('returns a fallback mcp module', async () => {
    const load = getHook(makePlugin(), 'load');
    const code = await load.call({}, '\0smrt-consumer:mcp');
    expect(code).toContain('export function createMCPServer');
    expect(code).toContain('tools: []');
  });

  it('returns a no-types message when the manifest has no objects', async () => {
    const load = getHook(makePlugin(), 'load');
    const code = await load.call({}, '\0smrt-consumer:types');
    expect(code).toContain('No types available');
  });

  it('returns a manifest module embedding the manifest JSON', async () => {
    const load = getHook(makePlugin(), 'load');
    const code = await load.call({}, '\0smrt-consumer:manifest');
    expect(code).toContain('export const manifest =');
    expect(code).toContain('export default manifest');
  });

  it('returns an empty web-definition module when no dependency manifest is available', async () => {
    const load = getHook(makePlugin(), 'load');
    const code = (await load.call({}, '\0smrt-consumer:web')) as string;
    const mod = await import(
      `data:text/javascript,${encodeURIComponent(code)}`
    );

    expect(mod.collectionDefinitions).toEqual({});
    expect(mod.webMcpToolDefinitions).toEqual([]);
    expect(typeof mod.manifestHash).toBe('string');
  });

  it('returns null for an unknown virtual id', async () => {
    const load = getHook(makePlugin(), 'load');
    expect(await load.call({}, '\0smrt-consumer:nope')).toBeNull();
  });
});

describe('smrtConsumer load with a populated manifest', () => {
  // After buildStart aggregates a manifest, the client/types fallbacks should
  // generate real per-object code instead of the empty placeholder.
  async function pluginWithObjects() {
    mkdirSync(join(projectRoot, 'node_modules', '@acme', 'widgets', 'dist'), {
      recursive: true,
    });
    writePackageJson(projectRoot, {
      name: 'consumer-app',
      version: '1.0.0',
    });
    writePackageJson(join(projectRoot, 'node_modules', '@acme', 'widgets'), {
      name: '@acme/widgets',
      version: '2.0.0',
      exports: { '.': './dist/index.js' },
    });
    const widgetsDist = join(
      projectRoot,
      'node_modules',
      '@acme',
      'widgets',
      'dist',
    );
    writeFileSync(
      join(widgetsDist, 'manifest.json'),
      JSON.stringify({
        packageName: '@acme/widgets',
        objects: {
          Widget: {
            className: 'Widget',
            collection: 'widgets',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          AuditEvent: {
            className: 'AuditEvent',
            collection: 'audit-events',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          HiddenWidget: {
            className: 'HiddenWidget',
            collection: 'hiddenWidgets',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          Report: {
            className: 'Report',
            collection: 'reports',
            fields: {},
            methods: {
              revealSecret: {
                name: 'revealSecret',
                parameters: [],
                returnType: 'string',
                isPublic: true,
                isStatic: false,
              },
            },
            decoratorConfig: { api: { include: ['get', 'revealSecret'] } },
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      packages: ['@acme/widgets'],
      generateTypes: false,
      projectRoot,
      disableScanning: true,
    });
    await plugin.buildStart?.call({} as any);
    return plugin;
  }

  it('generates a per-object client and typed interfaces', async () => {
    const plugin = await pluginWithObjects();
    const load = getHook(plugin, 'load');

    const client = (await load.call({}, '\0smrt-consumer:client')) as string;
    expect(client).toContain('"widgets":');
    expect(client).toContain("'/widgets'");
    expect(client).toContain('search:');
    expect(client).toContain('"reports":');
    expect(client).toContain('revealSecret:');
    expect(client).toContain('"audit-events":');
    expect(client).not.toContain('hiddenWidgets');

    const dataUri = `data:text/javascript,${encodeURIComponent(client)}`;
    const mod = await import(dataUri);
    const api = mod.createClient('/api/v1');
    expect(Object.keys(api)).toEqual(['audit-events', 'reports', 'widgets']);
    expect(Object.keys(api.reports).sort()).toEqual(['get', 'revealSecret']);
    expect(api['audit-events']).toBeDefined();
    expect(Object.keys(api.widgets).sort()).toEqual([
      'create',
      'delete',
      'get',
      'list',
      'search',
      'update',
    ]);

    const types = await load.call({}, '\0smrt-consumer:types');
    expect(types).toContain('export interface WidgetData');
  });

  it('applies the configured kebabRoutes policy to consumer custom methods', async () => {
    const plugin = smrtConsumer({
      packages: ['@acme/widgets'],
      generateTypes: false,
      projectRoot,
      disableScanning: true,
      kebabRoutes: true,
    });

    // Reuse the package fixture populated by the helper, then initialize this
    // plugin with the route policy used by the producer SvelteKit generator.
    await pluginWithObjects();
    await plugin.buildStart?.call({} as any);
    const load = getHook(plugin, 'load');
    const client = (await load.call({}, '\0smrt-consumer:client')) as string;

    expect(client).toContain("'/reports/' + id + '/reveal-secret'");
    expect(client).not.toContain("'/reports/' + id + '/revealSecret'");
  });

  it('emits SYNTACTICALLY VALID client code for a package-qualified manifest key (#1795)', async () => {
    // Regression guard for #1795: a qualified STI key like
    // `@happyvertical/smrt-assets:AssetAssociation` is not a valid bare
    // object-literal key. The pre-fix emission wrote it unquoted, producing a
    // build-breaking syntax error. The key must be quoted so the module parses.
    mkdirSync(join(projectRoot, 'node_modules', '@acme', 'assets', 'dist'), {
      recursive: true,
    });
    writePackageJson(projectRoot, { name: 'consumer-app', version: '1.0.0' });
    writePackageJson(join(projectRoot, 'node_modules', '@acme', 'assets'), {
      name: '@acme/assets',
      version: '1.0.0',
      exports: { '.': './dist/index.js' },
    });
    writeFileSync(
      join(
        projectRoot,
        'node_modules',
        '@acme',
        'assets',
        'dist',
        'manifest.json',
      ),
      JSON.stringify({
        packageName: '@acme/assets',
        objects: {
          '@acme/assets:AssetAssociation': {
            className: 'AssetAssociation',
            collection: 'asset_associations',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      packages: ['@acme/assets'],
      generateTypes: false,
      projectRoot,
      disableScanning: true,
    });
    await plugin.buildStart?.call({} as any);
    const load = getHook(plugin, 'load');
    const client = (await load.call({}, '\0smrt-consumer:client')) as string;

    // Runtime keys use the same stable collection key as declarations.
    expect(client).toContain('"asset_associations":');
    expect(client).not.toContain('@acme/assets:AssetAssociation');

    // The emitted module must be syntactically valid: import it as a data URI.
    // A pre-fix unquoted key throws SyntaxError here.
    const dataUri = `data:text/javascript,${encodeURIComponent(client)}`;
    const mod = await import(dataUri);
    expect(typeof mod.createClient).toBe('function');
    // The client exposes the stable collection key as its accessor.
    const api = mod.createClient('/api/v1');
    const accessor = api.asset_associations;
    expect(accessor).toBeDefined();
    // Every CRUD verb the declared CrudOperations promises is present.
    for (const verb of [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'search',
    ]) {
      expect(typeof accessor[verb]).toBe('function');
    }
  });

  it('bundles executable manifest and web definitions after default type generation', async () => {
    mkdirSync(join(projectRoot, 'node_modules', '@acme', 'widgets', 'dist'), {
      recursive: true,
    });
    writePackageJson(projectRoot, { name: 'consumer-app', version: '1.0.0' });
    writePackageJson(join(projectRoot, 'node_modules', '@acme', 'widgets'), {
      name: '@acme/widgets',
      version: '2.0.0',
      exports: { '.': './dist/index.js' },
    });
    writeFileSync(
      join(
        projectRoot,
        'node_modules',
        '@acme',
        'widgets',
        'dist',
        'manifest.json',
      ),
      JSON.stringify({
        packageName: '@acme/widgets',
        objects: {
          Widget: {
            className: 'Widget',
            collection: 'widgets',
            fields: { title: { type: 'text', required: true } },
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );
    writeFileSync(
      join(projectRoot, 'index.js'),
      [
        "import { manifest } from '@smrt/manifest';",
        "import setupRoutes from '@smrt/routes';",
        "import { createClient } from '@smrt/client';",
        "import { createMCPServer } from '@smrt/mcp';",
        "import { collectionDefinitions, getCollectionDefinition } from '@smrt/web';",
        'export const consumerManifest = manifest;',
        'export const runtimeExports = { setupRoutes, createClient, createMCPServer };',
        'export const widgetDefinition = collectionDefinitions.widgets;',
        "export const widgetObjectRef = getCollectionDefinition('widgets').objectRef;",
      ].join('\n'),
    );

    const result = await build({
      root: projectRoot,
      logLevel: 'silent',
      plugins: [
        smrtConsumer({
          packages: ['@acme/widgets'],
          projectRoot,
          disableScanning: true,
        }),
      ],
      build: {
        outDir: 'dist',
        lib: {
          entry: 'index.js',
          formats: ['es'],
          fileName: 'consumer',
        },
      },
    });

    expect(
      existsSync(join(projectRoot, 'src/types/smrt-generated/smrt-web.d.ts')),
    ).toBe(true);
    expect(
      existsSync(
        join(projectRoot, 'src/types/smrt-generated/smrt-manifest.d.ts'),
      ),
    ).toBe(true);
    const outputs = Array.isArray(result) ? result : [result];
    const bundle = outputs
      .flatMap((output) => output.output)
      .filter((output) => output.type === 'chunk')
      .map((output) => output.code)
      .join('\n');
    expect(bundle).toContain('@acme/widgets:Widget');
    expect(bundle).toContain('required: !0');
    const mod = await import(
      `data:text/javascript,${encodeURIComponent(bundle)}`
    );
    expect(mod.consumerManifest.objects.Widget).toMatchObject({
      packageName: '@acme/widgets',
      packageVersion: '2.0.0',
      className: 'Widget',
      collection: 'widgets',
      fields: { title: { type: 'text', required: true } },
    });
    expect(mod.widgetDefinition).toMatchObject({
      objectRef: '@acme/widgets:Widget',
      className: 'Widget',
      fields: { title: { type: 'text', required: true } },
    });
    expect(mod.widgetObjectRef).toBe('@acme/widgets:Widget');
    expect(typeof mod.runtimeExports.setupRoutes).toBe('function');
    expect(typeof mod.runtimeExports.createClient).toBe('function');
    expect(typeof mod.runtimeExports.createMCPServer).toBe('function');
  });
});

describe('smrtConsumer buildStart package discovery', () => {
  it('lets both plugins reuse one verified snapshot without discovery or manifest writes (#2328)', async () => {
    writePackageJson(projectRoot, {
      name: 'consumer-app',
      version: '1.0.0',
    });
    const provenance = 'git-tree:fixture';
    const artifactPath = join(projectRoot, 'generation-snapshot.json');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/LocalThing.ts'), 'export {};\n');
    const contents = serializeSmrtGenerationSnapshot(
      {
        version: '1.0.0',
        timestamp: 0,
        packageName: 'consumer-app',
        smrtDependencies: ['@acme/widgets'],
        objects: {
          'consumer-app:LocalThing': {
            className: 'LocalThing',
            qualifiedName: 'consumer-app:LocalThing',
            packageName: 'consumer-app',
            filePath: join(projectRoot, 'src/LocalThing.ts'),
            collection: 'local_things',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          '@acme/widgets:Widget': {
            className: 'Widget',
            qualifiedName: '@acme/widgets:Widget',
            packageName: '@acme/widgets',
            packageVersion: '2.0.0',
            importPath: '@acme/widgets',
            exportName: 'Widget',
            collection: 'widgets',
            fields: {
              title: { type: 'text', required: true },
            },
            methods: {},
            decoratorConfig: {},
          },
        },
      },
      provenance,
      { sourceRoot: projectRoot },
    );
    writeFileSync(artifactPath, contents);

    const generationSnapshot = {
      path: artifactPath,
      sha256: sha256SmrtGenerationSnapshot(contents),
      provenance,
      sourceRoot: projectRoot,
    };
    const consumer = smrtConsumer({
      generateTypes: false,
      projectRoot,
      packages: ['this-package-must-not-be-read'],
      generationSnapshot,
    });
    const producer: any = smrtPlugin({
      generateTypes: false,
      projectRoot,
      generationSnapshot,
    });
    await producer.configResolved({
      root: projectRoot,
      build: {},
      plugins: [consumer],
    });
    await consumer.buildStart?.call({} as any);

    const producerManifest = await getHook(producer, 'load').call(
      producer,
      '\0smrt:manifest',
    );
    const consumerManifest = await getHook(consumer, 'load').call(
      consumer,
      '\0smrt-consumer:manifest',
    );
    const consumerWeb = await getHook(consumer, 'load').call(
      consumer,
      '\0smrt-consumer:web',
    );

    expect(existsSync(join(projectRoot, '.smrt', 'manifest.json'))).toBe(false);
    expect(
      readFileSync(join(projectRoot, '.smrt', 'register.js'), 'utf8'),
    ).toContain("from '@acme/widgets'");
    expect(producerManifest).toContain('LocalThing');
    expect(producerManifest).not.toContain('@acme/widgets:Widget');
    expect(consumerManifest).toContain('@acme/widgets:Widget');
    expect(consumerManifest).not.toContain('LocalThing');
    const web = await import(
      `data:text/javascript,${encodeURIComponent(consumerWeb as string)}`
    );
    expect(web.collectionDefinitions.widgets).toMatchObject({
      objectRef: '@acme/widgets:Widget',
      className: 'Widget',
      fields: { title: { type: 'text', required: true } },
    });
    expect(web.collectionDefinitions.local_things).toBeUndefined();
    expect(readFileSync(artifactPath, 'utf8')).toBe(contents);
  });

  it('writes an aggregated manifest and discovers packages from package.json', async () => {
    // Auto-discovery (packages: []) scans dependencies whose names include "smrt".
    mkdirSync(
      join(projectRoot, 'node_modules', '@scope', 'smrt-things', 'dist'),
      { recursive: true },
    );
    writePackageJson(projectRoot, {
      name: 'consumer-app',
      version: '1.0.0',
      dependencies: { '@scope/smrt-things': '^1.0.0' },
    });
    writePackageJson(
      join(projectRoot, 'node_modules', '@scope', 'smrt-things'),
      { name: '@scope/smrt-things', version: '1.0.0', main: 'dist/index.js' },
    );
    writeFileSync(
      join(
        projectRoot,
        'node_modules',
        '@scope',
        'smrt-things',
        'dist',
        'manifest.json',
      ),
      JSON.stringify({
        packageName: '@scope/smrt-things',
        objects: {
          Thing: {
            className: 'Thing',
            collection: 'things',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      // packages omitted -> triggers discoverSmrtPackages
      generateTypes: false,
      projectRoot,
      disableScanning: false,
    });
    await plugin.buildStart?.call({} as any);

    const aggregatedPath = join(projectRoot, '.smrt', 'manifest.json');
    expect(existsSync(aggregatedPath)).toBe(true);
    const aggregated = JSON.parse(readFileSync(aggregatedPath, 'utf-8'));
    expect(aggregated.objects.Thing).toBeDefined();
    expect(aggregated.objects.Thing.packageName).toBe('@scope/smrt-things');
    // determineImportPath fell back to the package name (main field present).
    expect(aggregated.objects.Thing.importPath).toBe('@scope/smrt-things');
  });

  it('produces an empty manifest when no SMRT packages are found', async () => {
    writePackageJson(projectRoot, { name: 'consumer-app', version: '1.0.0' });

    const plugin = smrtConsumer({
      generateTypes: false,
      projectRoot,
      disableScanning: false,
    });
    await plugin.buildStart?.call({} as any);

    // No packages -> no aggregated manifest written, and no register.js.
    expect(existsSync(join(projectRoot, '.smrt', 'register.js'))).toBe(false);
  });

  it('uses the objects export path when package.json exposes ./objects', async () => {
    mkdirSync(join(projectRoot, 'node_modules', 'plain-pkg', 'dist'), {
      recursive: true,
    });
    writePackageJson(projectRoot, { name: 'consumer-app', version: '1.0.0' });
    writePackageJson(join(projectRoot, 'node_modules', 'plain-pkg'), {
      name: 'plain-pkg',
      version: '1.0.0',
      exports: {
        '.': './dist/index.js',
        './objects': './dist/objects.js',
      },
    });
    writeFileSync(
      join(projectRoot, 'node_modules', 'plain-pkg', 'dist', 'manifest.json'),
      JSON.stringify({
        objects: {
          Gadget: {
            className: 'Gadget',
            collection: 'gadgets',
            packageName: 'plain-pkg',
            hasCollection: false,
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      }),
    );

    const plugin = smrtConsumer({
      packages: ['plain-pkg'],
      generateTypes: false,
      projectRoot,
      disableScanning: true,
    });
    await plugin.buildStart?.call({} as any);

    const registerPath = join(projectRoot, '.smrt', 'register.js');
    expect(existsSync(registerPath)).toBe(true);
    const register = readFileSync(registerPath, 'utf-8');
    // determineImportPath chose the "./objects" subpath export.
    expect(register).toContain("from 'plain-pkg/objects'");
  });

  it('tolerates a package whose package.json is unreadable', async () => {
    // The package dir exists but has no package.json: aggregation should warn
    // and continue without throwing.
    mkdirSync(join(projectRoot, 'node_modules', 'broken-pkg'), {
      recursive: true,
    });
    writePackageJson(projectRoot, { name: 'consumer-app', version: '1.0.0' });

    const plugin = smrtConsumer({
      packages: ['broken-pkg'],
      generateTypes: false,
      projectRoot,
      disableScanning: true,
    });

    await expect(plugin.buildStart?.call({} as any)).resolves.toBeUndefined();
    const web = await getHook(plugin, 'load').call({}, '\0smrt-consumer:web');
    const module = await import(
      `data:text/javascript,${encodeURIComponent(web as string)}`
    );
    expect(module.collectionDefinitions).toEqual({});
  });
});

describe('smrtConsumer explicit SvelteKit route hosting (#2850)', () => {
  function writeProvider(
    packageName: string,
    objects: Record<string, Record<string, unknown>>,
  ): void {
    const packageDir = join(
      projectRoot,
      'node_modules',
      ...packageName.split('/'),
    );
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writePackageJson(packageDir, {
      name: packageName,
      version: '1.0.0',
      exports: { '.': './dist/index.js' },
    });
    writeFileSync(
      join(packageDir, 'dist', 'manifest.json'),
      JSON.stringify({ packageName, objects }),
    );
    writeFileSync(
      join(packageDir, 'dist', 'index.js'),
      Object.values(objects)
        .map((object) =>
          object.className === 'StaticActionWidget'
            ? 'export class StaticActionWidget { static publish() { return { published: true }; } }'
            : `export class ${object.className} {}`,
        )
        .join('\n') +
        '\nexport async function serializeBaseEvent(event) { return { title: event.title, secretBriefing: event.secretBriefing }; }\n',
    );
  }

  async function configureRoutes(
    options: Record<string, unknown>,
  ): Promise<void> {
    const plugin: any = smrtConsumer({
      packages: ['@acme/widgets', '@acme/other-widgets'],
      generateTypes: false,
      projectRoot,
      disableScanning: true,
      ...options,
    });
    const configHook = plugin.config;
    const handler =
      typeof configHook === 'function' ? configHook : configHook.handler;
    await handler({ root: projectRoot });
    return plugin;
  }

  beforeEach(() => {
    writePackageJson(projectRoot, {
      name: 'consumer-app',
      version: '1.0.0',
      type: 'module',
    });
    const coreLinkDir = join(projectRoot, 'node_modules', '@happyvertical');
    mkdirSync(coreLinkDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dirname, '../..'),
      join(coreLinkDir, 'smrt-core'),
    );
    const svelteKitLinkDir = join(projectRoot, 'node_modules', '@sveltejs');
    mkdirSync(svelteKitLinkDir, { recursive: true });
    symlinkSync(
      resolve(import.meta.dirname, '../../node_modules/@sveltejs/kit'),
      join(svelteKitLinkDir, 'kit'),
    );
    writeProvider('@acme/widgets', {
      '@acme/widgets:Widget': {
        className: 'Widget',
        qualifiedName: '@acme/widgets:Widget',
        collection: 'widgets',
        fields: {
          title: { type: 'text' },
          protected: { type: 'text', readonly: true },
        },
        methods: {},
        decoratorConfig: {
          api: {
            include: ['list', 'get', 'create', 'update'],
            writable: ['title'],
          },
          tenantScoped: { mode: 'required' },
        },
      },
      '@acme/widgets:AddedLater': {
        className: 'AddedLater',
        qualifiedName: '@acme/widgets:AddedLater',
        collection: 'added-later',
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
      '@acme/widgets:Hidden': {
        className: 'Hidden',
        qualifiedName: '@acme/widgets:Hidden',
        collection: 'hidden',
        fields: {},
        methods: {},
        decoratorConfig: { api: false },
      },
      '@acme/widgets:Empty': {
        className: 'Empty',
        qualifiedName: '@acme/widgets:Empty',
        collection: 'empty',
        fields: {},
        methods: {},
        decoratorConfig: { api: { include: [] } },
      },
      '@acme/widgets:Asset': {
        className: 'Asset',
        qualifiedName: '@acme/widgets:Asset',
        collection: 'assets',
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
      '@acme/widgets:StaticActionWidget': {
        className: 'StaticActionWidget',
        qualifiedName: '@acme/widgets:StaticActionWidget',
        collection: 'static-action-widgets',
        fields: {},
        methods: {
          publish: {
            name: 'publish',
            parameters: [],
            returnType: 'unknown',
            isPublic: true,
            isStatic: true,
          },
        },
        decoratorConfig: {
          api: {
            include: ['publish'],
            routes: { publish: { method: 'GET' } },
          },
        },
      },
      '@acme/widgets:BaseEvent': {
        className: 'BaseEvent',
        qualifiedName: '@acme/widgets:BaseEvent',
        collection: 'events',
        fields: { title: { type: 'text' } },
        methods: {},
        decoratorConfig: {
          api: {
            include: ['list', 'get'],
            serializers: {
              item: {
                exportName: 'serializeBaseEvent',
                importPath: '@acme/widgets',
              },
            },
          },
          tableStrategy: 'sti',
        },
      },
      '@acme/widgets:SecretEvent': {
        className: 'SecretEvent',
        qualifiedName: '@acme/widgets:SecretEvent',
        collection: 'secret-events',
        fields: {
          secretBriefing: {
            type: 'text',
            readPermission: 'events.read.secret',
          },
        },
        methods: {},
        decoratorConfig: { api: false },
        extends: 'BaseEvent',
        extendsQualified: '@acme/widgets:BaseEvent',
      },
      '@acme/widgets:BaseDefaultEvent': {
        className: 'BaseDefaultEvent',
        qualifiedName: '@acme/widgets:BaseDefaultEvent',
        collection: 'default-events',
        fields: { title: { type: 'text' } },
        methods: {},
        decoratorConfig: {
          api: { include: ['list'] },
          tableStrategy: 'sti',
        },
      },
      '@acme/widgets:SecretDefaultEvent': {
        className: 'SecretDefaultEvent',
        qualifiedName: '@acme/widgets:SecretDefaultEvent',
        collection: 'secret-default-events',
        fields: {
          secretBriefing: {
            type: 'text',
            readPermission: 'events.read.secret',
          },
        },
        methods: {},
        decoratorConfig: { api: false },
        extends: 'BaseDefaultEvent',
        extendsQualified: '@acme/widgets:BaseDefaultEvent',
      },
      '@acme/widgets:WireWidget': {
        className: 'WireWidget',
        qualifiedName: '@acme/widgets:WireWidget',
        collection: 'wire-widgets',
        fields: {},
        methods: {
          addAsset: {
            name: 'addAsset',
            parameters: [{ name: 'asset', type: 'Asset' }],
            returnType: 'void',
            isPublic: true,
            isStatic: false,
          },
        },
        decoratorConfig: { api: true },
      },
      '@acme/widgets:DuplicateActionWidget': {
        className: 'DuplicateActionWidget',
        qualifiedName: '@acme/widgets:DuplicateActionWidget',
        collection: 'duplicate-action-widgets',
        fields: {},
        methods: {
          firstAction: {
            name: 'firstAction',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: false,
          },
          'first-action': {
            name: 'first-action',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: false,
          },
        },
        decoratorConfig: {
          api: {
            include: ['firstAction', 'first-action'],
          },
        },
      },
      '@acme/widgets:MixedScopeActionWidget': {
        className: 'MixedScopeActionWidget',
        qualifiedName: '@acme/widgets:MixedScopeActionWidget',
        collection: 'mixed-scope-action-widgets',
        fields: {},
        methods: {
          staticPublish: {
            name: 'staticPublish',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: true,
          },
          publish: {
            name: 'publish',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: false,
          },
        },
        decoratorConfig: {
          api: {
            include: ['staticPublish', 'publish'],
            routes: {
              staticPublish: { method: 'GET', path: '[id]/publish' },
              publish: { method: 'POST', path: 'publish' },
            },
          },
        },
      },
      '@acme/widgets:SharedActionWidget': {
        className: 'SharedActionWidget',
        qualifiedName: '@acme/widgets:SharedActionWidget',
        collection: 'shared-action-widgets',
        fields: {},
        methods: {
          inspect: {
            name: 'inspect',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: false,
          },
          updateInspection: {
            name: 'updateInspection',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: false,
          },
        },
        decoratorConfig: {
          api: {
            include: ['inspect', 'updateInspection'],
            routes: {
              inspect: { method: 'GET', path: 'inspection' },
              updateInspection: { method: 'POST', path: 'inspection' },
            },
          },
        },
      },
      '@acme/widgets:CrudCollisionWidget': {
        className: 'CrudCollisionWidget',
        qualifiedName: '@acme/widgets:CrudCollisionWidget',
        collection: 'crud-collision-widgets',
        fields: {},
        methods: {
          publish: {
            name: 'publish',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: true,
          },
        },
        decoratorConfig: {
          api: {
            include: ['get', 'publish'],
            routes: {
              publish: { method: 'POST', path: '[id]' },
            },
          },
        },
      },
      '@acme/widgets:CrudActionWidget': {
        className: 'CrudActionWidget',
        qualifiedName: '@acme/widgets:CrudActionWidget',
        collection: 'crud-action-widgets',
        fields: {},
        methods: {
          publish: {
            name: 'publish',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: true,
          },
        },
        decoratorConfig: {
          api: {
            include: ['get', 'publish'],
            routes: {
              publish: { method: 'POST', path: '[id]/publish' },
            },
          },
        },
      },
      '@acme/widgets:ChangesCollisionWidget': {
        className: 'ChangesCollisionWidget',
        qualifiedName: '@acme/widgets:ChangesCollisionWidget',
        collection: '_changes',
        fields: {},
        methods: {},
        decoratorConfig: { api: { include: ['list'] } },
      },
      '@acme/widgets:KebabRouteWidget': {
        className: 'KebabRouteWidget',
        qualifiedName: '@acme/widgets:KebabRouteWidget',
        collection: 'kebab-route-widgets',
        fields: {},
        methods: {
          publishNow: {
            name: 'publishNow',
            parameters: [],
            returnType: 'void',
            isPublic: true,
            isStatic: false,
          },
        },
        decoratorConfig: { api: { include: ['get', 'publishNow'] } },
      },
    });
    writeProvider('@acme/other-widgets', {
      '@acme/other-widgets:Widget': {
        className: 'Widget',
        qualifiedName: '@acme/other-widgets:Widget',
        collection: 'widgets',
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
    });
  });

  it('emits only a selected qualified external object and retains generator guards', async () => {
    await configureRoutes({
      svelteKit: {
        objects: ['@acme/widgets:Widget'],
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
    });

    const collectionRoute = join(
      projectRoot,
      'src/routes/api/widgets/+server.ts',
    );
    const itemRoute = join(
      projectRoot,
      'src/routes/api/widgets/[id]/+server.ts',
    );
    expect(existsSync(collectionRoute)).toBe(true);
    expect(existsSync(itemRoute)).toBe(true);
    expect(readFileSync(itemRoute, 'utf8')).toContain("'@acme/widgets:Widget'");
    expect(readFileSync(itemRoute, 'utf8')).toContain(
      "import type { Widget } from '@acme/widgets';",
    );
    expect(readFileSync(collectionRoute, 'utf8')).toContain(
      'requireRouteAuth(locals, false);',
    );
    expect(readFileSync(collectionRoute, 'utf8')).toContain(
      'establishTenantContext(locals);',
    );
    expect(readFileSync(collectionRoute, 'utf8')).toContain(
      'function applyWritablePolicy',
    );
    expect(
      readFileSync(
        join(projectRoot, 'src/lib/server/smrt-register.ts'),
        'utf8',
      ),
    ).toContain('.smrt/register.js');
    expect(
      existsSync(join(projectRoot, 'src/routes/api/added-later/+server.ts')),
    ).toBe(false);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/other-widgets/+server.ts')),
    ).toBe(false);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/hidden/+server.ts')),
    ).toBe(false);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/empty/+server.ts')),
    ).toBe(false);
  });

  it('requires enabled: true before consumer utility routes are hosted', async () => {
    await configureRoutes({
      svelteKit: {
        objects: ['@acme/widgets:Widget'],
        changesRoute: {},
        eventsRoute: {},
        resourcesRoute: {},
      },
    });

    expect(
      existsSync(join(projectRoot, 'src/routes/api/_changes/+server.ts')),
    ).toBe(false);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/_events/+server.ts')),
    ).toBe(false);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/_resources/+server.ts')),
    ).toBe(false);
  });

  it('loads unselected provider identity through the generated SSR registration', async () => {
    const plugin = await configureRoutes({
      svelteKit: { objects: ['@acme/widgets:Widget'] },
    });
    await plugin.buildStart.call(plugin);
    const server = await createServer({
      root: projectRoot,
      logLevel: 'silent',
      plugins: [plugin],
      appType: 'custom',
      server: { middlewareMode: true },
    });
    try {
      await server.ssrLoadModule('/src/lib/server/smrt-register.ts');
      const { ObjectRegistry } = await import('@happyvertical/smrt-core');
      expect(
        ObjectRegistry.getClass('@acme/other-widgets:Widget'),
      ).toBeDefined();
      expect(
        existsSync(join(projectRoot, 'src/routes/api/widgets/+server.ts')),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('initializes a selected static collection action through its generated route and custom config location', async () => {
    const plugin = await configureRoutes({
      svelteKit: {
        objects: ['@acme/widgets:StaticActionWidget'],
        configPath: 'src/server/runtime',
        configFileName: 'registry.ts',
      },
    });
    await plugin.buildStart.call(plugin);

    const { ObjectRegistry } = await import('@happyvertical/smrt-core');
    ObjectRegistry.clear();
    const server = await createServer({
      root: projectRoot,
      logLevel: 'silent',
      plugins: [plugin],
      appType: 'custom',
      server: { middlewareMode: true },
    });
    try {
      const route: any = await server.ssrLoadModule(
        '/src/routes/api/static-action-widgets/publish/+server.ts',
      );
      const response = await route.GET({
        locals: { smrtAuth: true },
        url: new URL('http://localhost/api/static-action-widgets/publish'),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        action: 'publish',
        result: { published: true },
      });
      expect(
        ObjectRegistry.getClass('@acme/widgets:StaticActionWidget'),
      ).toBeDefined();
    } finally {
      await server.close();
      ObjectRegistry.clear();
    }
  });

  it('redacts an unselected STI descendant field from a selected base custom serializer', async () => {
    const configDir = join(projectRoot, 'src/server/runtime');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'registry.ts'),
      `export async function getCollection() {
  return {
    list: async () => [{ title: 'public event', secretBriefing: 'forbidden' }],
    get: async () => ({ title: 'public event', secretBriefing: 'forbidden' }),
    count: async () => 1,
  };
}
`,
    );
    const plugin = await configureRoutes({
      svelteKit: {
        objects: ['@acme/widgets:BaseEvent', '@acme/widgets:BaseDefaultEvent'],
        configPath: 'src/server/runtime',
        configFileName: 'registry.ts',
      },
    });
    const server = await createServer({
      root: projectRoot,
      logLevel: 'silent',
      plugins: [plugin],
      appType: 'custom',
      server: { middlewareMode: true },
    });
    try {
      const route: any = await server.ssrLoadModule(
        '/src/routes/api/events/+server.ts',
      );
      const response = await route.GET({
        locals: { smrtAuth: true },
        url: new URL('http://localhost/api/events'),
        request: new Request('http://localhost/api/events'),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        items: [{ title: 'public event' }],
        count: 1,
        limit: 50,
        offset: 0,
      });
      const authorizedResponse = await route.GET({
        locals: { smrtAuth: true, permissions: ['events.read.secret'] },
        url: new URL('http://localhost/api/events'),
        request: new Request('http://localhost/api/events'),
      });
      await expect(authorizedResponse.json()).resolves.toEqual({
        items: [{ title: 'public event', secretBriefing: 'forbidden' }],
        count: 1,
        limit: 50,
        offset: 0,
      });
      const itemRoute: any = await server.ssrLoadModule(
        '/src/routes/api/events/[id]/+server.ts',
      );
      const itemResponse = await itemRoute.GET({
        locals: { smrtAuth: true },
        params: { id: 'event-1' },
        request: new Request('http://localhost/api/events/event-1'),
      });
      await expect(itemResponse.json()).resolves.toEqual({
        title: 'public event',
      });
      const authorizedItemResponse = await itemRoute.GET({
        locals: { smrtAuth: true, permissions: ['events.read.secret'] },
        params: { id: 'event-1' },
        request: new Request('http://localhost/api/events/event-1'),
      });
      await expect(authorizedItemResponse.json()).resolves.toEqual({
        title: 'public event',
        secretBriefing: 'forbidden',
      });
      const routeSource = readFileSync(
        join(projectRoot, 'src/routes/api/events/+server.ts'),
        'utf8',
      );
      expect(routeSource).toContain('["secretBriefing","events.read.secret"]');
      expect(routeSource).toContain(
        "const READ_CACHE_CONTROL = 'private, no-cache';",
      );
      expect(routeSource).not.toContain('conditionalVersionedRead');
      const defaultRouteSource = readFileSync(
        join(projectRoot, 'src/routes/api/default-events/+server.ts'),
        'utf8',
      );
      expect(defaultRouteSource).toContain(
        '["secretBriefing","events.read.secret"]',
      );
      expect(defaultRouteSource).toContain(
        "const READ_CACHE_CONTROL = 'private, no-cache';",
      );
      expect(defaultRouteSource).toContain('conditionalJson(');
      expect(defaultRouteSource).not.toContain('conditionalVersionedRead');
      expect(
        existsSync(
          join(projectRoot, 'src/routes/api/secret-events/+server.ts'),
        ),
      ).toBe(false);
      expect(
        existsSync(
          join(projectRoot, 'src/routes/api/secret-default-events/+server.ts'),
        ),
      ).toBe(false);
      expect(
        existsSync(join(projectRoot, 'src/routes/api/sync/apply/+server.ts')),
      ).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('loads unselected snapshot providers through the generated SSR registration without smrtDependencies metadata', async () => {
    const widgets = JSON.parse(
      readFileSync(
        join(projectRoot, 'node_modules/@acme/widgets/dist/manifest.json'),
        'utf8',
      ),
    );
    const otherWidgets = JSON.parse(
      readFileSync(
        join(
          projectRoot,
          'node_modules/@acme/other-widgets/dist/manifest.json',
        ),
        'utf8',
      ),
    );
    const provenance = 'git-tree:snapshot-without-dependency-metadata';
    const snapshotContents = serializeSmrtGenerationSnapshot(
      {
        version: '1.0.0',
        timestamp: 0,
        packageName: 'consumer-app',
        objects: {
          ...Object.fromEntries(
            Object.entries(widgets.objects).map(([objectRef, objectDef]) => [
              objectRef,
              { ...objectDef, packageName: '@acme/widgets' },
            ]),
          ),
          ...Object.fromEntries(
            Object.entries(otherWidgets.objects).map(
              ([objectRef, objectDef]) => [
                objectRef,
                { ...objectDef, packageName: '@acme/other-widgets' },
              ],
            ),
          ),
        },
      },
      provenance,
      { sourceRoot: projectRoot },
    );
    const snapshotPath = join(projectRoot, 'generation-snapshot.json');
    writeFileSync(snapshotPath, snapshotContents);
    expect(
      JSON.parse(snapshotContents).manifest.smrtDependencies,
    ).toBeUndefined();

    const plugin: any = smrtConsumer({
      projectRoot,
      disableScanning: true,
      generationSnapshot: {
        path: snapshotPath,
        sha256: sha256SmrtGenerationSnapshot(snapshotContents),
        provenance,
        sourceRoot: projectRoot,
      },
      svelteKit: { objects: ['@acme/widgets:Widget'] },
    });
    const configHook = plugin.config;
    const config =
      typeof configHook === 'function' ? configHook : configHook.handler;
    await config({ root: projectRoot });
    await plugin.buildStart.call(plugin);

    const { ObjectRegistry } = await import('@happyvertical/smrt-core');
    ObjectRegistry.clear();
    const server = await createServer({
      root: projectRoot,
      logLevel: 'silent',
      plugins: [plugin],
      appType: 'custom',
      server: { middlewareMode: true },
    });
    try {
      await server.ssrLoadModule('/src/lib/server/smrt-register.ts');
      expect(
        ObjectRegistry.getClass('@acme/other-widgets:Widget'),
      ).toBeDefined();
      expect(
        existsSync(join(projectRoot, 'src/routes/api/widgets/+server.ts')),
      ).toBe(true);
      expect(
        existsSync(
          join(projectRoot, 'src/routes/api/other-widgets/+server.ts'),
        ),
      ).toBe(false);
    } finally {
      await server.close();
      ObjectRegistry.clear();
    }
  });

  it.each([
    ['the consumer package as object owner', 'consumer-app'],
    ['no object package metadata', undefined],
  ])('rejects hosted snapshot selection when the dependencies view filters %s', async (_caseName, packageName) => {
    const provenance = `git-tree:filtered-snapshot-${packageName ?? 'absent'}`;
    const snapshotContents = serializeSmrtGenerationSnapshot(
      {
        version: '1.0.0',
        timestamp: 0,
        packageName: 'consumer-app',
        objects: {
          '@acme/widgets:Widget': {
            className: 'Widget',
            qualifiedName: '@acme/widgets:Widget',
            ...(packageName === undefined ? {} : { packageName }),
            collection: 'widgets',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      },
      provenance,
      { sourceRoot: projectRoot },
    );
    const snapshotPath = join(projectRoot, 'filtered-snapshot.json');
    writeFileSync(snapshotPath, snapshotContents);
    const plugin: any = smrtConsumer({
      projectRoot,
      disableScanning: true,
      generationSnapshot: {
        path: snapshotPath,
        sha256: sha256SmrtGenerationSnapshot(snapshotContents),
        provenance,
        sourceRoot: projectRoot,
      },
      svelteKit: { objects: ['@acme/widgets:Widget'] },
    });
    const configHook = plugin.config;
    const config =
      typeof configHook === 'function' ? configHook : configHook.handler;

    await expect(config({ root: projectRoot })).rejects.toThrow(
      /references unknown dependency object/,
    );
    expect(readFileSync(snapshotPath, 'utf8')).toBe(snapshotContents);
    expect(existsSync(join(projectRoot, 'src/routes/api/widgets'))).toBe(false);
  });

  it('retains api false and empty include suppression for selected objects', async () => {
    await configureRoutes({
      svelteKit: {
        objects: [
          '@acme/widgets:Widget',
          '@acme/widgets:Hidden',
          '@acme/widgets:Empty',
        ],
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
    });

    expect(
      existsSync(join(projectRoot, 'src/routes/api/widgets/+server.ts')),
    ).toBe(true);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/hidden/+server.ts')),
    ).toBe(false);
    expect(
      existsSync(join(projectRoot, 'src/routes/api/empty/+server.ts')),
    ).toBe(false);
  });

  it('uses the full provider class inventory to suppress selected methods with unselected model inputs', async () => {
    await configureRoutes({
      svelteKit: { objects: ['@acme/widgets:WireWidget'] },
    });

    expect(
      existsSync(
        join(
          projectRoot,
          'src/routes/api/wire-widgets/[id]/addAsset/+server.ts',
        ),
      ),
    ).toBe(false);
  });

  it('rejects duplicate normalized custom handlers before removing an existing generated route', async () => {
    const existingRoute = join(
      projectRoot,
      'src/routes/api/duplicate-action-widgets/[id]/first-action/+server.ts',
    );
    mkdirSync(join(existingRoute, '..'), { recursive: true });
    writeFileSync(
      existingRoute,
      '// Auto-generated by @smrt/core vite plugin\n// preserve this route\n',
    );

    await expect(
      configureRoutes({
        svelteKit: {
          objects: ['@acme/widgets:DuplicateActionWidget'],
          kebabRoutes: true,
        },
      }),
    ).rejects.toThrow(/Duplicate custom API route handler/);

    expect(readFileSync(existingRoute, 'utf8')).toContain(
      '// preserve this route',
    );
  });

  it('rejects mixed-scope handlers before removing an existing generated route', async () => {
    const existingRoute = join(
      projectRoot,
      'src/routes/api/mixed-scope-action-widgets/[id]/publish/+server.ts',
    );
    mkdirSync(join(existingRoute, '..'), { recursive: true });
    writeFileSync(
      existingRoute,
      '// Auto-generated by @smrt/core vite plugin\n// preserve mixed scopes\n',
    );

    await expect(
      configureRoutes({
        svelteKit: {
          objects: ['@acme/widgets:MixedScopeActionWidget'],
        },
      }),
    ).rejects.toThrow(/same host type and scope/);

    expect(readFileSync(existingRoute, 'utf8')).toContain(
      '// preserve mixed scopes',
    );
  });

  it('allows same-scope custom handlers with different verbs at one path', async () => {
    await configureRoutes({
      svelteKit: { objects: ['@acme/widgets:SharedActionWidget'] },
    });

    const route = readFileSync(
      join(
        projectRoot,
        'src/routes/api/shared-action-widgets/[id]/inspection/+server.ts',
      ),
      'utf8',
    );
    expect(route).toContain('export const GET');
    expect(route).toContain('export const POST');
  });

  it('rejects CRUD and custom writers sharing one route file before removing it', async () => {
    const existingRoute = join(
      projectRoot,
      'src/routes/api/crud-collision-widgets/[id]/+server.ts',
    );
    mkdirSync(join(existingRoute, '..'), { recursive: true });
    writeFileSync(
      existingRoute,
      '// Auto-generated by @smrt/core vite plugin\n// preserve CRUD handler\n',
    );

    await expect(
      configureRoutes({
        svelteKit: { objects: ['@acme/widgets:CrudCollisionWidget'] },
      }),
    ).rejects.toThrow(/Conflicting SvelteKit route/);

    expect(readFileSync(existingRoute, 'utf8')).toContain(
      '// preserve CRUD handler',
    );
  });

  it('emits separate CRUD and custom handler files when their paths differ', async () => {
    await configureRoutes({
      svelteKit: { objects: ['@acme/widgets:CrudActionWidget'] },
    });

    const itemRoute = readFileSync(
      join(projectRoot, 'src/routes/api/crud-action-widgets/[id]/+server.ts'),
      'utf8',
    );
    const actionRoute = readFileSync(
      join(
        projectRoot,
        'src/routes/api/crud-action-widgets/[id]/publish/+server.ts',
      ),
      'utf8',
    );
    expect(itemRoute).toContain('export const GET');
    expect(actionRoute).toContain('export const POST');
  });

  it('rejects a selected CRUD writer that would replace the enabled changes route', async () => {
    const existingRoute = join(
      projectRoot,
      'src/routes/api/_changes/+server.ts',
    );
    mkdirSync(join(existingRoute, '..'), { recursive: true });
    writeFileSync(
      existingRoute,
      '// Auto-generated by @smrt/core vite plugin\n// preserve changes handler\n',
    );

    await expect(
      configureRoutes({
        svelteKit: {
          objects: ['@acme/widgets:ChangesCollisionWidget'],
          changesRoute: { enabled: true },
        },
      }),
    ).rejects.toThrow(/Conflicting SvelteKit route/);

    expect(readFileSync(existingRoute, 'utf8')).toContain(
      '// preserve changes handler',
    );
  });

  it('uses the nested SvelteKit kebab policy for handler, client, and web URLs', async () => {
    const plugin: any = smrtConsumer({
      packages: ['@acme/widgets', '@acme/other-widgets'],
      projectRoot,
      disableScanning: true,
      svelteKit: {
        objects: ['@acme/widgets:KebabRouteWidget'],
        kebabRoutes: true,
      },
    });
    const configHook = plugin.config;
    const config =
      typeof configHook === 'function' ? configHook : configHook.handler;
    await config({ root: projectRoot });
    await plugin.buildStart.call(plugin);

    const actionRoute = join(
      projectRoot,
      'src/routes/api/kebab-route-widgets/[id]/publish-now/+server.ts',
    );
    expect(existsSync(actionRoute)).toBe(true);

    const load = getHook(plugin, 'load');
    const client = (await load.call({}, '\0smrt-consumer:client')) as string;
    expect(client).toContain("'/kebab-route-widgets/' + id + '/publish-now'");
    expect(client).not.toContain(
      "'/kebab-route-widgets/' + id + '/publishNow'",
    );

    const web = (await load.call({}, '\0smrt-consumer:web')) as string;
    const webModule = await import(
      `data:text/javascript,${encodeURIComponent(web)}`
    );
    const tool = webModule.webMcpToolDefinitions.find(
      (definition: { action: string }) => definition.action === 'publishNow',
    );
    expect(tool?.route.path).toEqual(['publish-now']);

    const resolveId = getHook(plugin, 'resolveId');
    expect(resolveId.call({}, '@smrt/client', undefined)).toBe(
      '\0smrt-consumer:client',
    );
    expect(resolveId.call({}, '@smrt/web', undefined)).toBe(
      '\0smrt-consumer:web',
    );
    expect(
      existsSync(
        join(projectRoot, 'src/types/smrt-generated/smrt-client.d.ts'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(projectRoot, 'src/types/smrt-generated/smrt-web.d.ts')),
    ).toBe(true);
  });

  it('lets explicit nested kebabRoutes false override the top-level setting', async () => {
    const plugin: any = smrtConsumer({
      packages: ['@acme/widgets', '@acme/other-widgets'],
      generateTypes: false,
      projectRoot,
      disableScanning: true,
      kebabRoutes: true,
      svelteKit: {
        objects: ['@acme/widgets:KebabRouteWidget'],
        kebabRoutes: false,
      },
    });
    const configHook = plugin.config;
    const config =
      typeof configHook === 'function' ? configHook : configHook.handler;
    await config({ root: projectRoot });
    await plugin.buildStart.call(plugin);

    expect(
      existsSync(
        join(
          projectRoot,
          'src/routes/api/kebab-route-widgets/[id]/publishNow/+server.ts',
        ),
      ),
    ).toBe(true);
    const load = getHook(plugin, 'load');
    const client = (await load.call({}, '\0smrt-consumer:client')) as string;
    expect(client).toContain("'/kebab-route-widgets/' + id + '/publishNow'");
    const web = (await load.call({}, '\0smrt-consumer:web')) as string;
    const webModule = await import(
      `data:text/javascript,${encodeURIComponent(web)}`
    );
    const tool = webModule.webMcpToolDefinitions.find(
      (definition: { action: string }) => definition.action === 'publishNow',
    );
    expect(tool?.route.path).toEqual(['publishNow']);
  });

  it('rejects selected identities that would overwrite one route file', async () => {
    await expect(
      configureRoutes({
        svelteKit: {
          objects: ['@acme/widgets:Widget', '@acme/other-widgets:Widget'],
        },
      }),
    ).rejects.toThrow(/Conflicting SvelteKit route/);
    expect(existsSync(join(projectRoot, 'src/routes/api'))).toBe(false);
  });

  it('does not turn legacy svelteKit:true into external CRUD hosting', async () => {
    await configureRoutes({ svelteKit: true });
    expect(
      existsSync(join(projectRoot, 'src/routes/api/widgets/+server.ts')),
    ).toBe(false);
  });

  it.each([
    { objects: [] },
    { objects: ['Widget'] },
    { objects: ['@acme/widgets:Missing'] },
  ])('rejects an unsafe route object selection before emitting files', async (svelteKit) => {
    await expect(configureRoutes({ svelteKit })).rejects.toThrow(
      /svelteKit\.objects|qualified|unknown/i,
    );
    expect(existsSync(join(projectRoot, 'src/routes/api'))).toBe(false);
  });
});
