/**
 * Watch rebuilds with SvelteKit route generation enabled (#5462): a rebuild
 * generates routes before it publishes, so a refused rebuild keeps the prior
 * build's outputs, and concurrent buildStart hooks of the producer and the
 * consumer never deadlock on the lifecycle lock.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, type Rollup } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smrtConsumer } from '../consumer-plugin/index.js';
import { smrtPlugin } from './index.js';

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

function project(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `smrt-watch-rebuild-${name}-`));
  roots.push(root);
  mkdirSync(join(root, 'src', 'lib', 'objects'), { recursive: true });
  mkdirSync(join(root, 'src', 'lib', 'server'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: `@fixture/rebuild-${name}`, type: 'module' }),
  );
  writeFileSync(join(root, 'src', 'lib', 'objects', 'Note.ts'), model('Note'));
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
  return root;
}

const SVELTEKIT = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
  changesRoute: { enabled: false },
  eventsRoute: { enabled: false },
  resourcesRoute: { enabled: false },
};

function withinTimeout<T>(promise: Promise<T>, label: string, ms = 30_000) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms),
    ),
  ]);
}

type AnyPlugin = Record<string, any>;
const hook =
  (plugin: AnyPlugin, name: string) =>
  (...args: unknown[]) => {
    const value = plugin[name];
    const handler = typeof value === 'function' ? value : value.handler;
    return handler.apply(plugin, args);
  };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('watch rebuilds generate before publishing (#5462)', () => {
  it.each([
    ['producer first', true],
    ['consumer first', false],
  ])(
    'concurrent buildStarts never deadlock (%s)',
    async (_order, producerFirst) => {
      const root = project(producerFirst ? 'order-p' : 'order-c');
      const producer = smrtPlugin({
        projectRoot: root,
        include: ['src/**/*.ts'],
        svelteKit: SVELTEKIT,
      }) as unknown as AnyPlugin;
      const consumer = smrtConsumer({
        projectRoot: root,
        packages: ['@acme/widgets'],
        disableScanning: true,
        generateTypes: false,
      }) as unknown as AnyPlugin;
      const plugins = [producer, consumer];
      const lifecycle = { root, plugins };
      const env = { command: 'build', mode: 'test' };
      for (const plugin of plugins)
        await hook(plugin, 'config')(lifecycle, env);
      // A `vite build --watch` lifecycle: later buildStarts are watch rebuilds.
      const resolved = {
        root,
        mode: 'test',
        command: 'build',
        build: { watch: {} },
        plugins,
      };
      for (const plugin of plugins)
        await hook(plugin, 'configResolved')(resolved);
      // The initial buildStarts (the producer's reuses configResolved's scan).
      await withinTimeout(
        Promise.all(plugins.map((plugin) => hook(plugin, 'buildStart')())),
        'initial buildStarts',
      );
      writeFileSync(
        join(root, 'src', 'lib', 'objects', 'Note.ts'),
        model('Note', ['title', 'rebuiltField']),
      );
      // A watch rebuild of the producer, beside two consumer environments and
      // the producer's second, scanning environment.
      const runs = producerFirst
        ? [
            hook(producer, 'buildStart')(),
            hook(consumer, 'buildStart')(),
            hook(consumer, 'buildStart')(),
            hook(producer, 'buildStart')(),
          ]
        : [
            hook(consumer, 'buildStart')(),
            hook(producer, 'buildStart')(),
            hook(consumer, 'buildStart')(),
            hook(producer, 'buildStart')(),
          ];
      await withinTimeout(Promise.all(runs), 'concurrent buildStarts');
      const manifest = JSON.parse(
        readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8'),
      );
      expect(Object.keys(manifest.objects).sort()).toEqual([
        '@acme/widgets:Widget',
        `@fixture/rebuild-${producerFirst ? 'order-p' : 'order-c'}:Note`,
      ]);
      expect(JSON.stringify(manifest)).toContain('rebuiltField');
      expect(
        readFileSync(
          join(root, 'src', 'types', 'virtual-modules.d.ts'),
          'utf-8',
        ),
      ).toContain('rebuiltField');
    },
    120_000,
  );

  it('a refused watch rebuild keeps the previous outputs, and the next rebuild publishes', async () => {
    const root = project('watch');
    writeFileSync(
      join(root, 'src', 'entry.ts'),
      "import './lib/objects/Note.ts';\nexport const entry = true;\n",
    );
    const producer = smrtPlugin({
      projectRoot: root,
      include: ['src/lib/**/*.ts'],
      svelteKit: SVELTEKIT,
    });
    const events: string[] = [];
    let resolveEvent: ((name: string) => void) | undefined;
    const nextEvent = () =>
      new Promise<string>((resolve) => {
        resolveEvent = resolve;
      });
    let pending = nextEvent();
    const watcher = (await build({
      root,
      configFile: false,
      logLevel: 'silent',
      oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
      plugins: [producer],
      build: {
        outDir: join(root, 'dist-out'),
        emptyOutDir: true,
        minify: false,
        watch: {},
        rollupOptions: {
          input: join(root, 'src', 'entry.ts'),
          external: [/^@happyvertical\//],
        },
      },
    })) as Rollup.RollupWatcher;
    watcher.on('event', (event) => {
      if (event.code === 'BUNDLE_END' || event.code === 'ERROR') {
        events.push(event.code);
        if (event.code === 'BUNDLE_END') event.result?.close();
        resolveEvent?.(event.code);
      }
    });
    try {
      expect(await withinTimeout(pending, 'initial build')).toBe('BUNDLE_END');
      const declarations = join(root, 'src', 'types', 'virtual-modules.d.ts');
      const prior = {
        declarations: readFileSync(declarations, 'utf-8'),
        manifest: readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8'),
        knowledge: readFileSync(
          join(root, '.smrt', 'smrt-knowledge.json'),
          'utf-8',
        ),
        surface: JSON.stringify(
          await producer.api.resolveKnowledgeAgentSurface(),
        ),
        route: readFileSync(
          join(root, 'src', 'routes', 'api', 'notes', '+server.ts'),
          'utf-8',
        ),
      };

      // The edit makes a route collide with a hand-written handler.
      const handler = join(root, 'src', 'routes', 'api', 'lamps', '+server.ts');
      mkdirSync(join(handler, '..'), { recursive: true });
      writeFileSync(handler, APPLICATION_HANDLER);
      writeFileSync(
        join(root, 'src', 'lib', 'objects', 'Note.ts'),
        `${model('Note', ['title', 'rebuiltField'])}\n${model('Lamp').split('\n').slice(2).join('\n')}`,
      );
      pending = nextEvent();
      expect(await withinTimeout(pending, 'refused rebuild')).toBe('ERROR');
      expect(readFileSync(declarations, 'utf-8')).toBe(prior.declarations);
      expect(readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8')).toBe(
        prior.manifest,
      );
      expect(
        readFileSync(join(root, '.smrt', 'smrt-knowledge.json'), 'utf-8'),
      ).toBe(prior.knowledge);
      expect(
        JSON.stringify(await producer.api.resolveKnowledgeAgentSurface()),
      ).toBe(prior.surface);
      expect(
        readFileSync(
          join(root, 'src', 'routes', 'api', 'notes', '+server.ts'),
          'utf-8',
        ),
      ).toBe(prior.route);
      expect(readFileSync(handler, 'utf-8')).toBe(APPLICATION_HANDLER);

      // Recovery: without the handler the next rebuild publishes.
      unlinkSync(handler);
      writeFileSync(
        join(root, 'src', 'lib', 'objects', 'Note.ts'),
        `${model('Note', ['title', 'rebuiltField', 'recovered'])}\n${model('Lamp').split('\n').slice(2).join('\n')}`,
      );
      pending = nextEvent();
      expect(await withinTimeout(pending, 'recovery rebuild')).toBe(
        'BUNDLE_END',
      );
      expect(readFileSync(declarations, 'utf-8')).toContain('recovered');
      expect(
        readFileSync(join(root, '.smrt', 'manifest.json'), 'utf-8'),
      ).toContain('Lamp');
      expect(
        existsSync(join(root, 'src', 'routes', 'api', 'lamps', '+server.ts')),
      ).toBe(true);
    } finally {
      await watcher.close();
    }
  }, 180_000);
});
