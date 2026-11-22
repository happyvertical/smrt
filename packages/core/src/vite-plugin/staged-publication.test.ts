/**
 * Staged publication (#5462): a refused route generation publishes nothing;
 * an accepted one publishes one prepared result, at settlement, under the
 * committed root. The plugin is driven through its own hooks on temporary
 * projects (no database).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smrtPlugin } from './index.js';

const gate = vi.hoisted(() => ({
  knowledgeConfig: undefined as Promise<void> | undefined,
  knowledgeConfigCalls: 0,
}));

// Holds the first project-config resolution of a test until released, so a
// preparation can be paused between its scan and its route submission.
vi.mock('../knowledge-config.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../knowledge-config.js')>();
  return {
    ...original,
    resolveFileKnowledgeConfig: async (
      ...args: Parameters<typeof original.resolveFileKnowledgeConfig>
    ) => {
      gate.knowledgeConfigCalls++;
      const pending = gate.knowledgeConfig;
      gate.knowledgeConfig = undefined;
      if (pending) await pending;
      return original.resolveFileKnowledgeConfig(...args);
    },
  };
});

const WAIT = { timeout: 20_000, interval: 50 };

const APPLICATION_HANDLER =
  "export const GET = () => new Response('application handler');\n";

const roots: string[] = [];

function model(className: string, fields: string[] = ['title']): string {
  return `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { include: ['list', 'get'] } })
export class ${className} extends SmrtObject {
${fields.map((field) => `  ${field} = '';`).join('\n')}
}
`;
}

function intent(id: string): string {
  return `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const staged = defineIntent({
  id: '${id}',
  description: 'Staged publication fixture intent',
  target: { registry: 'dataSurface', controlId: 'notes', kind: 'table' },
});
`;
}

function project(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `smrt-staged-${name}-`));
  roots.push(root);
  mkdirSync(join(root, 'src', 'lib', 'objects'), { recursive: true });
  mkdirSync(join(root, 'src', 'lib', 'server'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: `@fixture/staged-${name}`, type: 'module' }),
  );
  writeFileSync(
    join(root, 'smrt.config.json'),
    JSON.stringify({ knowledge: { api: { enabled: true } } }),
  );
  writeFileSync(join(root, 'src', 'lib', 'objects', 'Note.ts'), model('Note'));
  return root;
}

function pluginFor(root?: string, svelteKit = true) {
  return smrtPlugin({
    ...(root ? { projectRoot: root } : {}),
    include: ['src/**/*.ts'],
    svelteKit: svelteKit
      ? {
          enabled: true,
          routesDir: 'src/routes/api',
          objectsDir: 'src/lib/objects',
          changesRoute: { enabled: false },
          eventsRoute: { enabled: false },
          resourcesRoute: { enabled: false },
        }
      : { enabled: false },
  });
}

type AnyPlugin = Record<string, unknown> & { api: any };

function hook(plugin: AnyPlugin, name: string): (...args: any[]) => any {
  const value = plugin[name] as any;
  const handler = typeof value === 'function' ? value : value?.handler;
  return (...args: any[]) => handler.apply(plugin, args);
}

function resolvedConfig(root: string, plugin: AnyPlugin) {
  return {
    root,
    mode: 'test',
    command: 'build',
    build: {},
    plugins: [plugin],
  };
}

async function configHook(plugin: AnyPlugin, userConfig: object) {
  return hook(plugin, 'config')(userConfig, {
    command: 'build',
    mode: 'test',
  });
}

/** Path to bytes (or absence) of every published output under `root`. */
function outputs(root: string): Record<string, string | null> {
  const read = (path: string) =>
    existsSync(path) ? readFileSync(path, 'utf-8') : null;
  const smrtDir = join(root, '.smrt');
  const files: Record<string, string | null> = {
    'src/types/virtual-modules.d.ts': read(
      join(root, 'src', 'types', 'virtual-modules.d.ts'),
    ),
  };
  if (existsSync(smrtDir)) {
    for (const name of readdirSync(smrtDir).sort()) {
      // The package-discovery cache is the scanner's, not a publication.
      if (name === 'discovery-cache.json') continue;
      files[`.smrt/${name}`] = read(join(smrtDir, name));
    }
  }
  return files;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  gate.knowledgeConfig = undefined;
  gate.knowledgeConfigCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('config-hook generation publishes at settlement', () => {
  it('a refused config-hook generation leaves the declarations and .smrt untouched', async () => {
    // Clean tree: nothing exists before, nothing after.
    const clean = project('refused-clean');
    mkdirSync(join(clean, 'src', 'routes', 'api', 'notes'), {
      recursive: true,
    });
    writeFileSync(
      join(clean, 'src', 'routes', 'api', 'notes', '+server.ts'),
      APPLICATION_HANDLER,
    );
    const cleanPlugin = pluginFor(clean) as unknown as AnyPlugin;
    await expect(
      configHook(cleanPlugin, { root: clean, plugins: [cleanPlugin] }),
    ).rejects.toMatchObject({ code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT' });
    expect(Object.keys(outputs(clean))).toEqual([
      'src/types/virtual-modules.d.ts',
    ]);
    expect(outputs(clean)['src/types/virtual-modules.d.ts']).toBeNull();

    // Previously built tree: a later refused run keeps every byte.
    const built = project('refused-built');
    const first = pluginFor(built) as unknown as AnyPlugin;
    await configHook(first, { root: built, plugins: [first] });
    await hook(first, 'configResolved')(resolvedConfig(built, first));
    const before = outputs(built);
    expect(before['.smrt/manifest.json']).toContain('Note');
    writeFileSync(
      join(built, 'src', 'lib', 'objects', 'Lamp.ts'),
      model('Lamp'),
    );
    mkdirSync(join(built, 'src', 'routes', 'api', 'lamps'), {
      recursive: true,
    });
    writeFileSync(
      join(built, 'src', 'routes', 'api', 'lamps', '+server.ts'),
      APPLICATION_HANDLER,
    );
    const second = pluginFor(built) as unknown as AnyPlugin;
    await expect(
      configHook(second, { root: built, plugins: [second] }),
    ).rejects.toMatchObject({ code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT' });
    expect(outputs(built)).toEqual(before);
  }, 60_000);

  it('a later config-hook abort keeps the published artifacts beside the committed routes', async () => {
    const root = project('later-abort');
    const plugin = pluginFor(root) as unknown as AnyPlugin;
    // The smrt config hook succeeds; a following plugin's config hook then
    // throws, so configResolved never runs.
    await configHook(plugin, { root, plugins: [plugin] });
    const route = join(root, 'src', 'routes', 'api', 'notes', '+server.ts');
    expect(existsSync(route)).toBe(true);
    const published = outputs(root);
    expect(published['src/types/virtual-modules.d.ts']).toContain('Note');
    expect(
      Object.keys(
        JSON.parse(published['.smrt/manifest.json'] ?? '{}').objects ?? {},
      ),
    ).toEqual(['@fixture/staged-later-abort:Note']);
    expect(published['.smrt/smrt-knowledge.json']).toContain('Note');
  }, 60_000);

  it('a refused fallback generation leaves .smrt untouched', async () => {
    const root = project('refused-fallback');
    // A previous build published .smrt.
    const first = pluginFor(root) as unknown as AnyPlugin;
    await hook(first, 'configResolved')(resolvedConfig(root, first));
    const before = outputs(root);
    expect(before['.smrt/manifest.json']).toContain('Note');

    writeFileSync(
      join(root, 'src', 'lib', 'objects', 'Lamp.ts'),
      model('Lamp'),
    );
    mkdirSync(join(root, 'src', 'routes', 'api', 'lamps'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'routes', 'api', 'lamps', '+server.ts'),
      APPLICATION_HANDLER,
    );
    // No config hook ran: configResolved generates as the fallback.
    const second = pluginFor(root) as unknown as AnyPlugin;
    await expect(
      hook(second, 'configResolved')(resolvedConfig(root, second)),
    ).rejects.toMatchObject({ code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT' });
    for (const [path, bytes] of Object.entries(before)) {
      if (path.startsWith('.smrt/')) expect(outputs(root)[path]).toBe(bytes);
    }
  }, 60_000);

  it('a root mismatch warns and publishes under the committed root', async () => {
    const committed = project('root-committed');
    const resolved = project('root-resolved');
    const plugin = pluginFor() as unknown as AnyPlugin;
    const warn = vi.mocked(console.warn);
    // No projectRoot option: the config hook resolves userConfig.root, and
    // Vite later resolves a different root.
    await configHook(plugin, { root: committed, plugins: [plugin] });
    await hook(plugin, 'configResolved')(resolvedConfig(resolved, plugin));
    await hook(plugin, 'buildStart')();

    expect(existsSync(join(committed, '.smrt', 'manifest.json'))).toBe(true);
    expect(
      existsSync(join(committed, 'src', 'types', 'virtual-modules.d.ts')),
    ).toBe(true);
    expect(existsSync(join(resolved, '.smrt'))).toBe(false);
    expect(
      existsSync(join(resolved, 'src', 'types', 'virtual-modules.d.ts')),
    ).toBe(false);
    expect(
      warn.mock.calls.some(
        ([message]) =>
          String(message).includes(committed) &&
          String(message).includes(resolved),
      ),
    ).toBe(true);

    // The knowledge module reads the committed root's artifact.
    const knowledgeRoute = readFileSync(
      join(committed, 'src', 'routes', '__smrt', 'knowledge', '+server.ts'),
      'utf-8',
    );
    const moduleId = /from "(smrt:knowledge-artifact\/[0-9a-f]+)"/.exec(
      knowledgeRoute,
    )?.[1];
    expect(moduleId).toBeDefined();
    const resolvedId = await hook(plugin, 'resolveId')(moduleId);
    const load = plugin.load as (this: unknown, id: string) => Promise<string>;
    const source = await load.call(
      { environment: { config: { consumer: 'server' } } },
      resolvedId,
    );
    const artifact = JSON.parse(
      readFileSync(join(committed, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
    );
    expect(source).toBe(`export default ${JSON.stringify(artifact)};\n`);
  }, 60_000);
});

describe('prepared results are atomic and sequence-ordered', () => {
  it('a scan error leaves the surface unchanged', async () => {
    const root = project('scan-error');
    writeFileSync(join(root, 'src', 'intents.ts'), intent('notes.previous'));
    const plugin = pluginFor(root, false) as unknown as AnyPlugin;
    await hook(plugin, 'configResolved')(resolvedConfig(root, plugin));
    // The first buildStart reuses configResolved's scan.
    await hook(plugin, 'buildStart')();
    const before = await plugin.api.resolveKnowledgeAgentSurface();
    expect(JSON.stringify(before)).toContain('notes.previous');

    // One edit changes the declared intent and breaks another source file.
    writeFileSync(join(root, 'src', 'intents.ts'), intent('notes.current'));
    writeFileSync(
      join(root, 'src', 'lib', 'objects', 'Broken.ts'),
      "import { smrt } from '@happyvertical/smrt-core';\n@smrt()\nexport class Broken extends {\n",
    );
    await expect(hook(plugin, 'buildStart')()).rejects.toThrow();
    const after = await plugin.api.resolveKnowledgeAgentSurface();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('notes.current');
  }, 60_000);

  it('overlapping publishes end at the highest sequence', async () => {
    const root = project('overlap');
    const plugin = pluginFor(root, false) as unknown as AnyPlugin;
    // Records the lifecycle and root; route generation is off.
    await configHook(plugin, { root, plugins: [plugin] });
    const { OxcScanner } = await import('@happyvertical/smrt-scanner');
    const original = OxcScanner.prototype.scanAndResolve;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    vi.spyOn(OxcScanner.prototype, 'scanAndResolve').mockImplementation(
      async function (this: InstanceType<typeof OxcScanner>, ...args) {
        // The first preparation (load's) reads the sources, then is held
        // until the second (buildStart's) has published.
        const result = await original.apply(this, args);
        if (++calls === 1) await held;
        return result;
      },
    );
    // load() self-prepares: nothing is published yet.
    const loading = hook(plugin, 'load')('\0smrt:manifest');
    await vi.waitFor(() => expect(calls).toBe(1), WAIT);
    writeFileSync(
      join(root, 'src', 'lib', 'objects', 'Note.ts'),
      model('Note', ['title', 'newestField']),
    );
    await hook(plugin, 'buildStart')();
    release();
    await loading;

    const declarations = readFileSync(
      join(root, 'src', 'types', 'virtual-modules.d.ts'),
      'utf-8',
    );
    expect(declarations).toContain('newestField');
    expect(
      readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8'),
    ).toContain('newestField');
  }, 60_000);

  it('a rescan prepared before a newer publish is rejected', async () => {
    const root = project('stale-rescan');
    const plugin = pluginFor(root) as unknown as AnyPlugin;
    // A refused config-hook generation records the lifecycle and publishes
    // nothing; the conflict is then removed.
    const handler = join(root, 'src', 'routes', 'api', 'notes', '+server.ts');
    mkdirSync(join(handler, '..'), { recursive: true });
    writeFileSync(handler, APPLICATION_HANDLER);
    await expect(
      configHook(plugin, { root, plugins: [plugin] }),
    ).rejects.toMatchObject({ code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT' });
    rmSync(join(root, 'src', 'routes'), { recursive: true, force: true });
    vi.mocked(console.log).mockClear();
    gate.knowledgeConfigCalls = 0;
    const handlers: Record<string, (file: string) => Promise<void>> = {};
    hook(
      plugin,
      'configureServer',
    )({
      middlewares: { use() {} },
      watcher: {
        on(kind: string, callback: (file: string) => Promise<void>) {
          handlers[kind] = callback;
        },
      },
      config: { root },
      moduleGraph: { getModuleById: () => undefined },
    });
    // The rescan (seq N) is held after its scan, before it submits.
    let releaseRescan!: () => void;
    gate.knowledgeConfig = new Promise<void>((resolve) => {
      releaseRescan = resolve;
    });
    const rescan = handlers.change(
      join(root, 'src', 'lib', 'objects', 'Note.ts'),
    );
    await vi.waitFor(() => expect(gate.knowledgeConfigCalls).toBe(1), WAIT);
    // load() prepares and publishes N + 1 first.
    await hook(plugin, 'load')('\0smrt:manifest');
    expect(existsSync(join(root, '.smrt', 'manifest.json'))).toBe(true);
    releaseRescan();
    await rescan;

    // N never reached the generator: no route file was written.
    expect(existsSync(join(root, 'src', 'routes'))).toBe(false);
    expect(
      vi
        .mocked(console.log)
        .mock.calls.some(([message]) =>
          String(message).includes('Generating SvelteKit routes'),
        ),
    ).toBe(false);
  }, 60_000);

  it('a lock is released by the handle it was acquired with', async () => {
    const { svelteKitLifecycleLock } = await import(
      './sveltekit-route-coordinator.js'
    );
    const root = project('lock-handle');
    const plugin = pluginFor(root, false) as unknown as AnyPlugin;
    // Vite's lifecycle object is the config `env` (`env ?? userConfig`).
    const first = { command: 'build', mode: 'test' };
    await hook(plugin, 'config')({ root, plugins: [plugin] }, first);
    // The publication holds the first lifecycle's lock while it resolves the
    // project knowledge config.
    let releasePublish!: () => void;
    gate.knowledgeConfig = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    gate.knowledgeConfigCalls = 0;
    const publishing = hook(
      plugin,
      'configResolved',
    )(resolvedConfig(root, plugin));
    await vi.waitFor(() => expect(gate.knowledgeConfigCalls).toBe(1), WAIT);
    // Meanwhile the instance records a second lifecycle.
    await configHook(plugin, { root, plugins: [plugin] });
    releasePublish();
    await publishing;
    // The first lifecycle's lock was released: a later acquirer completes.
    const release = await Promise.race([
      svelteKitLifecycleLock(first).acquire(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('first lock never released')), 5_000),
      ),
    ]);
    release();
  }, 60_000);
});

/**
 * A dev server whose watcher events the test delivers itself, so the order
 * of route-tree events relative to a rescan is exact.
 */
function controlledDevServer(plugin: AnyPlugin, root: string) {
  const handlers: Record<string, (file: string) => Promise<void>> = {};
  hook(
    plugin,
    'configureServer',
  )({
    middlewares: { use() {} },
    watcher: {
      on(kind: string, callback: (file: string) => Promise<void>) {
        handlers[kind] = callback;
      },
    },
    config: { root },
    moduleGraph: { getModuleById: () => undefined },
  });
  return handlers;
}

const rescanLogs = () =>
  vi
    .mocked(console.log)
    .mock.calls.map(([message]) => String(message))
    .filter((message) => message.includes('Rescanning'));

function writeProvider(root: string): void {
  const provider = join(root, 'node_modules', '@acme', 'widgets');
  mkdirSync(join(provider, 'dist'), { recursive: true });
  writeFileSync(
    join(provider, 'package.json'),
    JSON.stringify({
      name: '@acme/widgets',
      version: '1.0.0',
      exports: { '.': './dist/index.js' },
    }),
  );
  writeFileSync(join(provider, 'dist', 'index.js'), 'export class Widget {}\n');
  writeFileSync(
    join(provider, 'dist', 'manifest.json'),
    JSON.stringify({
      packageName: '@acme/widgets',
      objects: {
        '@acme/widgets:Widget': {
          className: 'Widget',
          qualifiedName: '@acme/widgets:Widget',
          collection: 'widgets',
          fields: {},
          methods: {},
          decoratorConfig: {},
        },
      },
    }),
  );
}

describe('refused-pending and the lock at the plugin level (#5462)', () => {
  afterEach(async () => {
    const { setSvelteKitCoordinatorPauseHookForTesting } = await import(
      './sveltekit-route-coordinator.js'
    );
    const { setRouteFileSystemForTesting } = await import(
      './generated-route-files.js'
    );
    setSvelteKitCoordinatorPauseHookForTesting?.(undefined);
    setRouteFileSystemForTesting?.(undefined);
  });

  it('a nested afterGenerate failure after acceptance leaves refused-pending unarmed', async () => {
    const { contributeSvelteKitRoutes, markSvelteKitRouteParticipant } =
      await import('./sveltekit-route-coordinator.js');
    const root = project('nested-after-generate');
    const plugin = pluginFor(root) as unknown as AnyPlugin;
    const peer = { name: 'peer-consumer' };
    markSvelteKitRouteParticipant(peer, 'consumer', true, 'src/routes/api');
    const lifecycle = { command: 'serve', mode: 'test' };
    await hook(plugin, 'config')({ root, plugins: [plugin, peer] }, lifecycle);
    let failReconciliation = false;
    const nested = join(root, 'src', 'routes', 'api', 'former', '+server.ts');
    const empty = { version: '1', timestamp: 0, objects: {} } as never;
    await contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
      owner: 'consumer',
      routeManifest: empty,
      semanticManifest: empty,
      options: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
        kebabRoutes: false,
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
      afterGenerate: () => {
        // A nested refusal names a file, as a reconciliation conflict does.
        if (failReconciliation) {
          throw Object.assign(new Error('nested reconciliation failed'), {
            files: [nested],
          });
        }
      },
    });
    const handlers = controlledDevServer(plugin, root);

    // An accepted rescan whose nested reconciliation then fails.
    failReconciliation = true;
    await handlers.change(join(root, 'src', 'lib', 'objects', 'Note.ts'));
    expect(
      vi
        .mocked(console.error)
        .mock.calls.some(([, error]) =>
          String((error as Error)?.message).includes(
            'nested reconciliation failed',
          ),
        ),
    ).toBe(true);

    // No refusal was armed: neither the file the nested error named nor any
    // other route-tree event is admitted.
    vi.mocked(console.log).mockClear();
    const other = join(root, 'src', 'routes', 'api', 'other', '+server.ts');
    for (const file of [nested, other]) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, APPLICATION_HANDLER);
      await handlers.add(file);
    }
    expect(rescanLogs()).toEqual([]);
  }, 60_000);

  it('an accepted-but-thrown rescan admits only the files its error named', async () => {
    const { nodeRouteFileSystem, setRouteFileSystemForTesting } = await import(
      './generated-route-files.js'
    );
    const root = project('narrow-pending');
    const plugin = pluginFor(root) as unknown as AnyPlugin;
    await hook(plugin, 'config')(
      { root, plugins: [plugin] },
      { command: 'serve', mode: 'test' },
    );
    const handlers = controlledDevServer(plugin, root);
    const kite = join(root, 'src', 'routes', 'api', 'kites', '+server.ts');
    // Another writer creates an application file just before the exclusive
    // create: the commit refuses after the registration already changed.
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      openSync: (path, flag) => {
        if (path === kite && flag === 'wx') {
          mkdirSync(join(kite, '..'), { recursive: true });
          writeFileSync(kite, APPLICATION_HANDLER);
        }
        return nodeRouteFileSystem.openSync(path, flag);
      },
    });
    writeFileSync(
      join(root, 'src', 'lib', 'objects', 'Kite.ts'),
      model('Kite'),
    );
    await handlers.add(join(root, 'src', 'lib', 'objects', 'Kite.ts'));
    setRouteFileSystemForTesting(undefined);
    const commitError = vi
      .mocked(console.error)
      .mock.calls.map(
        ([, error]) => error as { phase?: string; files?: string[] },
      )
      .find((error) => error?.phase === 'commit');
    expect(commitError?.files).toEqual([kite]);
    // Accepted: the scan was published.
    expect(
      readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8'),
    ).toContain('Kite');

    // While that pending is armed, an unrelated route event is ignored...
    vi.mocked(console.log).mockClear();
    const other = join(root, 'src', 'routes', 'api', 'other', '+server.ts');
    mkdirSync(join(other, '..'), { recursive: true });
    writeFileSync(other, APPLICATION_HANDLER);
    await handlers.add(other);
    expect(rescanLogs()).toEqual([]);

    // ...and an event on the named file retries.
    rmSync(kite);
    await handlers.unlink(kite);
    expect(rescanLogs()).toHaveLength(1);
    expect(rescanLogs()[0]).toContain(kite);
    expect(readFileSync(kite, 'utf-8')).toContain(
      '// Auto-generated by @smrt/core vite plugin',
    );
  }, 60_000);

  it('a lazy shared-target rescan builds the consumer registration from the manifest it publishes', async () => {
    const { smrtConsumer } = await import('../consumer-plugin/index.js');
    const root = project('lazy-shared');
    writeProvider(root);
    const lazySvelteKit = {
      enabled: true,
      lazyActivation: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      changesRoute: { enabled: false },
      eventsRoute: { enabled: false },
      resourcesRoute: { enabled: false },
    };
    const producer = smrtPlugin({
      projectRoot: root,
      include: ['src/**/*.ts'],
      svelteKit: lazySvelteKit,
    }) as unknown as AnyPlugin;
    const consumer = smrtConsumer({
      projectRoot: root,
      packages: ['@acme/widgets'],
      disableScanning: true,
      generateTypes: false,
      lazyActivation: true,
      svelteKit: { objects: ['@acme/widgets:Widget'] },
    }) as unknown as AnyPlugin;
    const plugins = [producer, consumer];
    const lifecycle = { command: 'serve', mode: 'test' };
    for (const plugin of plugins) {
      await hook(plugin, 'config')({ root, plugins }, lifecycle);
    }
    const handlers = controlledDevServer(producer, root);

    // A rescan that adds a local model.
    writeFileSync(
      join(root, 'src', 'lib', 'objects', 'Lamp.ts'),
      model('Lamp'),
    );
    await handlers.add(join(root, 'src', 'lib', 'objects', 'Lamp.ts'));

    const manifest = JSON.parse(
      readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(manifest.objects)).toContain(
      '@fixture/staged-lazy-shared:Lamp',
    );
    // `.smrt/register.js` and the data modules it loads name every class the
    // published manifest holds.
    const registration: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (path.endsWith('.js') && !path.endsWith('build-schema.js')) {
          registration.push(readFileSync(path, 'utf-8'));
        }
      }
    };
    collect(join(root, '.smrt'));
    expect(registration.join('\n').length).toBeGreaterThan(0);
    for (const key of Object.keys(manifest.objects)) {
      expect(registration.join('\n')).toContain(key);
    }
  }, 90_000);

  it('a consumer registration write overlapping a producer rescan leaves the last holder’s activation manifest', async () => {
    const { smrtConsumer } = await import('../consumer-plugin/index.js');
    const { setSvelteKitCoordinatorPauseHookForTesting } = await import(
      './sveltekit-route-coordinator.js'
    );
    const root = project('activation-overlap');
    writeProvider(root);
    const producer = smrtPlugin({
      projectRoot: root,
      include: ['src/**/*.ts'],
      svelteKit: {
        enabled: true,
        lazyActivation: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
    }) as unknown as AnyPlugin;
    const consumer = smrtConsumer({
      projectRoot: root,
      packages: ['@acme/widgets'],
      disableScanning: true,
      generateTypes: false,
      lazyActivation: true,
    }) as unknown as AnyPlugin;
    const plugins = [producer, consumer];
    const lifecycle = { command: 'serve', mode: 'test' };
    for (const plugin of plugins) {
      await hook(plugin, 'config')({ root, plugins }, lifecycle);
    }
    const resolved = {
      root,
      mode: 'test',
      command: 'serve',
      build: {},
      plugins,
    };
    for (const plugin of plugins)
      await hook(plugin, 'configResolved')(resolved);
    await hook(producer, 'buildStart')();
    await hook(consumer, 'buildStart')();
    const activation = join(root, '.smrt', 'activation-manifest.json');
    expect(readFileSync(activation, 'utf-8')).toContain('@acme/widgets:Widget');
    const handlers = controlledDevServer(producer, root);

    // The producer rescan holds the lifecycle lock, paused before its
    // generator writes.
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    setSvelteKitCoordinatorPauseHookForTesting(async (point) => {
      if (point !== 'beforeMark') return;
      reached();
      await released;
    });
    writeFileSync(
      join(root, 'src', 'lib', 'objects', 'Note.ts'),
      model('Note', ['title', 'overlapField']),
    );
    const rescan = handlers.change(
      join(root, 'src', 'lib', 'objects', 'Note.ts'),
    );
    await paused;
    // The consumer's registration write overlaps: it waits at the lock.
    const before = readFileSync(activation, 'utf-8');
    const consumerRun = hook(consumer, 'buildStart')();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(readFileSync(activation, 'utf-8')).toBe(before);
    release();
    await rescan;
    await consumerRun;
    setSvelteKitCoordinatorPauseHookForTesting(undefined);

    // The consumer held the lock last: its activation manifest, built from
    // the producer's published manifest, is the one on disk.
    const final = readFileSync(activation, 'utf-8');
    expect(final).toContain('@acme/widgets:Widget');
    expect(final).toContain('@fixture/staged-activation-overlap:Note');
    const manifest = JSON.parse(
      readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(JSON.stringify(manifest)).toContain('overlapField');
    expect(Object.keys(manifest.objects).sort()).toEqual([
      '@acme/widgets:Widget',
      '@fixture/staged-activation-overlap:Note',
    ]);
  }, 90_000);
});

describe('dev start generates once (#5462)', () => {
  it('a dev start runs exactly one route generation across both environments', async () => {
    const { createServer } = await import('vite');
    const root = project('dev-start');
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      // Every environment runs plugin buildStart hooks (SSR lazily), the
      // multi-environment start a later buildStart must not regenerate in.
      server: {
        middlewareMode: true,
        watch: null,
        perEnvironmentStartEndDuringDev: true,
      },
      plugins: [pluginFor(root)],
    });
    try {
      // The client environment starts at init; the SSR environment's
      // buildStart runs lazily on its first module load.
      await server.ssrLoadModule('@happyvertical/smrt-virt-manifest');
      // Vite starts each environment's buildStart once; this awaits the SSR
      // one (already started by the load above, or started here).
      await server.environments.ssr.pluginContainer.buildStart({});
      const generations = vi
        .mocked(console.log)
        .mock.calls.filter(([message]) =>
          String(message).includes('Generating SvelteKit routes'),
        );
      expect(generations).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 60_000);
});
