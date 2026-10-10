/**
 * The full bakery cookbook hosts its package models without route conflicts
 * (#3749). The manifests are the real ones: every workspace package the
 * cookbook's recipes come from is scanned from source by the same
 * `ManifestBuilder` the package build uses, so the STI collection inheritance
 * (`Order`, `WholesaleOrder`, `PurchaseOrder`, `ProductionOrder` share the
 * `contracts` collection; `Product` and `Material` share `products`) is
 * exactly what a consumer sees.
 */
import {
  copyFileSync,
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
import type { Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManifestBuilder } from '../manifest/generator.js';
import { resolveCookbookHostedObjects } from './cookbook-exposure.js';
import { smrt } from './index.js';

type AnyPlugin = Plugin & Record<string, any>;

const PACKAGES = ['commerce', 'inventory', 'ledgers', 'products'] as const;
const REPO = resolve(import.meta.dirname, '../../../..');
const BAKERY = resolve(
  import.meta.dirname,
  '../cookbook/__fixtures__/bakery.cookbook.json',
);

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

describe('the bakery cookbook over the real workspace manifests (#3749)', () => {
  let root: string;
  let names: string[];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'smrt-bakery-hosting-'));
    names = [];
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"@fixture/bakery","version":"1.0.0","type":"module"}',
    );
    mkdirSync(join(root, 'src/lib/models'), { recursive: true });
    mkdirSync(join(root, 'src/lib/server'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '@happyvertical'), {
      recursive: true,
    });
    mkdirSync(join(root, 'node_modules', '@sveltejs'), { recursive: true });
    symlinkSync(
      resolve(import.meta.dirname, '../..'),
      join(root, 'node_modules', '@happyvertical', 'smrt-core'),
    );
    symlinkSync(
      resolve(import.meta.dirname, '../../node_modules/@sveltejs/kit'),
      join(root, 'node_modules', '@sveltejs', 'kit'),
    );
    copyFileSync(BAKERY, join(root, 'smrt.cookbook.json'));

    for (const pkg of PACKAGES) {
      const manifest = await new ManifestBuilder(
        join(REPO, 'packages', pkg),
      ).generate({
        include: ['src/**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/__tests__/**',
          '**/*.d.ts',
          '**/test-support/**',
        ],
        outputDir: join(root, '.manifest-out', pkg),
        outputMode: 'build',
        outputName: 'manifest.json',
        generateTypeStub: false,
        injectPackageInfo: true,
        discoverExternalPackages: true,
        includeExternalBaseClasses: true,
      });
      const packageName = manifest.packageName as string;
      names.push(packageName);
      const dir = join(root, 'node_modules', packageName);
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: packageName,
          version: '1.0.0',
          exports: { '.': './dist/index.js' },
        }),
      );
      writeFileSync(
        join(dir, 'dist', 'index.js'),
        Object.values(manifest.objects)
          .map((o: any) => `export class ${o.className} {}`)
          .join('\n'),
      );
      writeFileSync(
        join(dir, 'dist', 'manifest.json'),
        JSON.stringify(manifest),
      );
    }
  }, 180_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('generates a route for every STI class it hosts, each at the endpoint its definition advertises', async () => {
    const hosted = resolveCookbookHostedObjects(root, names);
    const commerce = (model: string) => `@happyvertical/smrt-commerce:${model}`;
    const sti = [
      commerce('Order'),
      commerce('WholesaleOrder'),
      commerce('PurchaseOrder'),
      commerce('ProductionOrder'),
    ];
    for (const model of sti) expect(hosted).toContain(model);

    const plugins = (await smrt({
      projectRoot: root,
      packages: names,
      objectsDir: 'src/lib/models',
    })) as AnyPlugin[];
    const userConfig = { root, plugins };
    const env = { command: 'build', mode: 'production' };
    // The shared-collection conflict surfaced here.
    for (const p of plugins) await callHook(p, 'config', userConfig, env);

    const consumer = plugins.find(
      (p) => p.name === 'smrt-consumer',
    ) as AnyPlugin;
    await callHook(consumer, 'buildStart', {});
    const code = (await callHook(
      consumer,
      'load',
      '\0smrt-consumer:web',
    )) as string;
    const web = await import(
      `data:text/javascript,${encodeURIComponent(code)}`
    );
    const definitions = Object.values(web.collectionDefinitions) as Array<{
      objectRef: string;
      endpoint: string;
      actions: string[];
    }>;

    let checked = 0;
    for (const ref of hosted) {
      const definition = definitions.find((d) => d.objectRef === ref);
      if (!definition) continue; // api: false or no list route
      checked++;
      expect(
        existsSync(
          join(root, 'src/routes/api', definition.endpoint, '+server.ts'),
        ),
        `${ref} advertises ${definition.endpoint} but no route serves it`,
      ).toBe(true);
    }
    expect(checked).toBeGreaterThanOrEqual(sti.length);
    for (const model of sti) {
      expect(definitions.some((d) => d.objectRef === model)).toBe(true);
    }
    // The shared table's collection is the base's, and the base is not hosted.
    expect(existsSync(join(root, 'src/routes/api/contracts'))).toBe(false);
    // Contract allows no delete; its hosted subclasses inherit that, so the
    // route accepts no DELETE (fail closed, not the omitted-config full CRUD).
    for (const model of sti) {
      const def = definitions.find((d) => d.objectRef === model);
      const detail = readFileSync(
        join(root, 'src/routes/api', def?.endpoint ?? '', '[id]/+server.ts'),
        'utf8',
      );
      expect(detail, model).not.toMatch(/export (const|async function) DELETE/);
      expect(def?.actions, model).not.toContain('delete');
    }
    // Product and Material no longer collide either.
    const endpoints = definitions.map((d) => d.endpoint);
    expect(new Set(endpoints).size).toBe(endpoints.length);
  }, 180_000);
});
