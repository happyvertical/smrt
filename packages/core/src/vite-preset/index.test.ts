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
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smrtConsumer } from '../consumer-plugin/index.js';
import { smrtPlugin } from '../vite-plugin/index.js';
import { SMRT_PRESET_DEFAULTS, smrt } from './index.js';

type AnyPlugin = Plugin & Record<string, any>;

function callHook(plugin: AnyPlugin, name: string, ...args: unknown[]) {
  const hook = plugin[name];
  if (!hook) return undefined;
  const fn = typeof hook === 'function' ? hook : hook.handler;
  return fn.call(
    {
      warn() {},
      error: (m: string) => {
        throw new Error(m);
      },
    },
    ...args,
  );
}

async function runBuild(plugins: AnyPlugin[], root: string) {
  for (const p of plugins) {
    await callHook(p, 'configResolved', { root, build: {}, plugins });
  }
  for (const p of plugins) await callHook(p, 'buildStart', {});
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(full);
      else {
        out[relative(root, full)] = readFileSync(full, 'utf8')
          .split(root)
          .join('<root>');
      }
    }
  };
  walk(root);
  return out;
}

const OBJECT_SOURCE = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { include: ['list', 'get'] } })
export class Item extends SmrtObject {
  title: string = '';
}
`;

describe('smrt() Vite preset', () => {
  let root: string;
  let cwd: string;

  const writeProvider = (name = '@test/pkg', manifest = true) => {
    const dir = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        exports: { '.': './dist/index.js' },
      }),
    );
    if (manifest) {
      writeFileSync(
        join(dir, 'dist', 'manifest.json'),
        JSON.stringify({
          moduleType: 'smrt',
          packageName: name,
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
    }
  };

  const writeConfig = (packages: unknown) =>
    writeFileSync(
      join(root, 'smrt.config.json'),
      JSON.stringify(packages === undefined ? {} : { consumer: { packages } }),
    );

  beforeEach(() => {
    cwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'smrt-preset-'));
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"app","version":"1.0.0"}',
    );
    mkdirSync(join(root, 'src/lib/objects'), { recursive: true });
    mkdirSync(join(root, 'src/lib/server'), { recursive: true });
    writeFileSync(join(root, 'src/lib/objects/item.ts'), OBJECT_SOURCE);
    writeFileSync(
      join(root, 'src/lib/server/smrt.ts'),
      'export async function getCollection() { return {}; }\n',
    );
    writeProvider();
  });

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  describe('defaults', () => {
    it('composes decorators, consumer, then producer, in template order', async () => {
      const plugins = await smrt({
        projectRoot: root,
        packages: ['@test/pkg'],
      });
      expect(plugins.map((p) => p.name)).toEqual([
        'smrt:decorators',
        'smrt:shared-runtime',
        smrtConsumer({ packages: ['@test/pkg'] }).name,
        smrtPlugin().name,
      ]);
    });

    it('exposes the template conventions as defaults', () => {
      expect(SMRT_PRESET_DEFAULTS).toMatchObject({
        objectsDir: 'src/lib/objects',
        typesDir: 'src/lib/types/smrt-generated',
        routesDir: 'src/routes/api',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      });
    });

    it('applies the Oxc legacy decorator config', async () => {
      const [decorators] = (await smrt({ packages: [] })) as AnyPlugin[];
      expect(callHook(decorators, 'config', {})).toEqual({
        oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
      });
    });

    it('never overwrites decorator values the app set itself', async () => {
      const [decorators] = (await smrt({ packages: [] })) as AnyPlugin[];
      expect(
        callHook(decorators, 'config', {
          oxc: { decorator: { legacy: true, emitDecoratorMetadata: false } },
        }),
      ).toBeUndefined();
      expect(
        callHook(decorators, 'config', {
          oxc: { decorator: { legacy: false } },
        }),
      ).toEqual({ oxc: { decorator: { emitDecoratorMetadata: true } } });
    });

    it('dedupes @sveltejs/kit so SMRT SvelteKit entries share the app copy', async () => {
      const plugins = (await smrt({ packages: [] })) as AnyPlugin[];
      const shared = plugins.find((p) => p.name === 'smrt:shared-runtime');
      expect(shared).toBeDefined();
      expect(callHook(shared as AnyPlugin, 'config', {})).toEqual({
        resolve: { dedupe: ['@sveltejs/kit'] },
      });
    });

    it('omits the decorator plugin when decorators is false', async () => {
      const plugins = await smrt({ packages: [], decorators: false });
      expect(plugins.map((p) => p.name)).not.toContain('smrt:decorators');
    });
  });

  describe('package list source', () => {
    it('reads consumer.packages from smrt.config', async () => {
      writeConfig(['@test/pkg']);
      const plugins = await smrt({ projectRoot: root });
      await runBuild(plugins as AnyPlugin[], root);
      expect(readFileSync(join(root, '.smrt/register.js'), 'utf8')).toContain(
        "from '@test/pkg'",
      );
    });

    it('prefers the direct option over smrt.config', async () => {
      writeConfig(['@test/other']);
      writeProvider('@test/direct');
      const plugins = await smrt({
        projectRoot: root,
        packages: ['@test/direct'],
      });
      await runBuild(plugins as AnyPlugin[], root);
      const register = readFileSync(join(root, '.smrt/register.js'), 'utf8');
      expect(register).toContain('@test/direct');
      expect(register).not.toContain('@test/other');
    });

    it('searches smrt.config from the cwd when projectRoot is omitted', async () => {
      writeConfig(['@test/pkg']);
      process.chdir(root);
      const plugins = await smrt();
      expect(plugins.map((p) => p.name)).toContain(
        smrtConsumer({ packages: ['@test/pkg'] }).name,
      );
      expect(plugins).toHaveLength(4);
    });

    it('does not sniff package.json dependencies', async () => {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { '@test/pkg': '1.0.0' } }),
      );
      writeConfig(undefined);
      await expect(smrt({ projectRoot: root })).rejects.toThrow(
        /No consumer package list declared/,
      );
    });

    it('fails clearly when no list is declared anywhere', async () => {
      await expect(smrt({ projectRoot: root })).rejects.toThrow(
        /consumer: \{ packages/,
      );
    });

    it.each([
      ['not an array', 'nope'],
      ['non-string entry', ['@test/pkg', 3]],
      ['blank entry', ['  ']],
      ['null', null],
    ])('rejects a malformed config list (%s)', async (_n, value) => {
      writeConfig(value);
      await expect(smrt({ projectRoot: root })).rejects.toThrow(
        /must be an array of non-empty package names/,
      );
    });

    it('rejects a malformed direct option', async () => {
      await expect(
        smrt({ packages: 'x' as unknown as string[] }),
      ).rejects.toThrow(/smrt\(\{ packages \}\)/);
    });

    it('wraps a config that cannot be loaded', async () => {
      writeFileSync(join(root, 'smrt.config.json'), '{ not json');
      await expect(smrt({ projectRoot: root })).rejects.toThrow(
        /Could not read smrt\.config/,
      );
    });

    it('treats an empty list as "consumes nothing" and skips the consumer plugin', async () => {
      writeConfig([]);
      const names = (await smrt({ projectRoot: root })).map((p) => p.name);
      expect(names).toEqual([
        'smrt:decorators',
        'smrt:shared-runtime',
        smrtPlugin().name,
      ]);
    });

    it('fails closed when an empty list contradicts an installed provider', async () => {
      const plugins = await smrt({ projectRoot: root, packages: [] });
      await expect(runBuild(plugins as AnyPlugin[], root)).rejects.toThrow(
        /missing smrtConsumer\(\)/,
      );
    });

    it('deduplicates and trims listed packages', async () => {
      const plugins = await smrt({
        projectRoot: root,
        packages: ['@test/pkg', ' @test/pkg '],
      });
      await runBuild(plugins as AnyPlugin[], root);
      const register = readFileSync(join(root, '.smrt/register.js'), 'utf8');
      expect(register.match(/__smrt_provider_\d+ from/g)).toHaveLength(1);
    });

    it('fails the build for a listed package that provides no manifest', async () => {
      writeProvider('@test/nomanifest', false);
      const plugins = await smrt({
        projectRoot: root,
        packages: ['@test/nomanifest'],
      });
      await expect(runBuild(plugins as AnyPlugin[], root)).rejects.toThrow(
        /nomanifest/,
      );
    });
  });

  describe('overrides', () => {
    it('honors every path override end to end', async () => {
      mkdirSync(join(root, 'app/models'), { recursive: true });
      mkdirSync(join(root, 'app/runtime'), { recursive: true });
      writeFileSync(join(root, 'app/models/item.ts'), OBJECT_SOURCE);
      writeFileSync(
        join(root, 'app/runtime/registry.ts'),
        'export async function getCollection() { return {}; }\n',
      );
      const plugins = await smrt({
        projectRoot: root,
        packages: ['@test/pkg'],
        objectsDir: 'app/models',
        typesDir: 'app/types',
        routesDir: 'app/api',
        configPath: 'app/runtime',
        configFileName: 'registry.ts',
      });
      await runBuild(plugins as AnyPlugin[], root);
      expect(existsSync(join(root, 'app/api/items/[id]/+server.ts'))).toBe(
        true,
      );
      expect(existsSync(join(root, 'app/types'))).toBe(true);
      expect(existsSync(join(root, 'src/routes/api'))).toBe(false);
      expect(existsSync(join(root, 'src/lib/types'))).toBe(false);
    });

    it('lets include/exclude replace the objectsDir-derived scan globs', async () => {
      rmSync(join(root, 'node_modules'), { recursive: true, force: true });
      writeFileSync(join(root, 'src/lib/objects/item.test.ts'), OBJECT_SOURCE);
      const plugins = await smrt({
        projectRoot: root,
        packages: [],
        include: ['nothing/**/*.ts'],
      });
      await runBuild(plugins as AnyPlugin[], root);
      expect(existsSync(join(root, 'src/routes/api/items'))).toBe(false);
    });
  });

  describe('equivalence with the two-plugin form', () => {
    it('generates identical output for the same inputs', async () => {
      const manual = [
        smrtConsumer({
          projectRoot: root,
          packages: ['@test/pkg'],
          generateTypes: true,
          typesDir: 'src/lib/types/smrt-generated',
          svelteKit: true,
        }),
        smrtPlugin({
          projectRoot: root,
          include: ['src/lib/objects/**/*.ts'],
          exclude: ['**/*.test.ts', '**/*.spec.ts'],
          generateTypes: true,
          typeDeclarationsPath: 'src/lib/types/smrt-generated',
          svelteKit: {
            enabled: true,
            routesDir: 'src/routes/api',
            objectsDir: 'src/lib/objects',
            configPath: 'src/lib/server',
            configFileName: 'smrt.ts',
          },
        }),
      ] as AnyPlugin[];
      await runBuild(manual, root);
      const expected = snapshot(root);
      expect(Object.keys(expected)).toContain(
        'src/routes/api/items/[id]/+server.ts',
      );
      expect(Object.keys(expected)).toContain('.smrt/register.js');
      expect(
        Object.keys(expected).some((k) =>
          k.startsWith('src/lib/types/smrt-generated/'),
        ),
      ).toBe(true);

      rmSync(join(root, '.smrt'), { recursive: true, force: true });
      rmSync(join(root, 'src/routes'), { recursive: true, force: true });
      rmSync(join(root, 'src/lib/types'), { recursive: true, force: true });

      const preset = await smrt({ projectRoot: root, packages: ['@test/pkg'] });
      await runBuild(preset as AnyPlugin[], root);
      const actual = snapshot(root);

      const strip = (s: Record<string, string>) =>
        Object.fromEntries(
          Object.entries(s).map(([k, v]) => [
            k,
            v
              .replace(
                /("(?:timestamp|generatedAt)":\s*)("[^"]*"|\d+)/g,
                '$1"<t>"',
              )
              .replace(/Generated at: .*/g, 'Generated at: <t>'),
          ]),
        );
      expect(strip(actual)).toEqual(strip(expected));
    });
  });

  describe('existing call sites', () => {
    it('keeps smrtConsumer and smrtPlugin working on their own subpaths', async () => {
      const consumer = await import('../consumer-plugin.js');
      const producer = await import('../vite-plugin.js');
      expect(consumer.smrtConsumer).toBe(smrtConsumer);
      expect(producer.smrtPlugin).toBe(smrtPlugin);
      expect(typeof smrtConsumer({ packages: [] }).name).toBe('string');
      expect(typeof smrtPlugin().name).toBe('string');
    });
  });
});
