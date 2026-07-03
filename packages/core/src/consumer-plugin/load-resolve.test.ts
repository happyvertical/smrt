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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('resolves a virtual module to the physical .d.ts file when it exists', () => {
    const typesDir = 'src/types/smrt-generated';
    mkdirSync(join(projectRoot, typesDir), { recursive: true });
    const declPath = join(projectRoot, typesDir, 'smrt-client.d.ts');
    writeFileSync(declPath, '// types');

    const plugin = smrtConsumer({
      packages: [],
      typesDir,
      projectRoot,
      disableScanning: true,
    });
    const resolveId = getHook(plugin, 'resolveId');

    const resolved = resolveId.call({}, '@smrt/client', undefined);
    expect(resolved).toBe(declPath);
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

    const client = await load.call({}, '\0smrt-consumer:client');
    // Object keys are quoted (#1795), so a simple name appears as "Widget":.
    expect(client).toContain('"Widget":');
    expect(client).toContain("'/widgets'");

    const types = await load.call({}, '\0smrt-consumer:types');
    expect(types).toContain('export interface WidgetData');
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

    // The qualified key is present and QUOTED.
    expect(client).toContain('"@acme/assets:AssetAssociation":');

    // The emitted module must be syntactically valid: import it as a data URI.
    // A pre-fix unquoted key throws SyntaxError here.
    const dataUri = `data:text/javascript,${encodeURIComponent(client)}`;
    const mod = await import(dataUri);
    expect(typeof mod.createClient).toBe('function');
    // The client exposes the qualified key as a collection accessor.
    const api = mod.createClient('/api/v1');
    expect(api['@acme/assets:AssetAssociation']).toBeDefined();
    expect(typeof api['@acme/assets:AssetAssociation'].list).toBe('function');
  });
});

describe('smrtConsumer buildStart package discovery', () => {
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
  });
});
