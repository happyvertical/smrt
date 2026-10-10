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
import { getDatabase } from '@happyvertical/sql';
import { createServer, type Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCookbookHostedObjects } from './cookbook-exposure.js';
import { smrt } from './index.js';

type AnyPlugin = Plugin & Record<string, any>;

const PKG = '@test/commerce';
const ref = (model: string) => `${PKG}:${model}`;

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

const model = (
  className: string,
  collection: string,
  decoratorConfig: Record<string, unknown>,
  fields: Record<string, unknown> = { number: { type: 'text' } },
) => ({
  className,
  qualifiedName: ref(className),
  packageName: PKG,
  collection,
  fields,
  methods: {},
  decoratorConfig,
});

describe('cookbook-driven hosting of consumed package models (#3749)', () => {
  let root: string;

  const writeCookbook = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(root, 'smrt.cookbook.json'),
      JSON.stringify({
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
        version: 1,
        recipes: ['commerce.sales'],
        features: [],
        policies: [],
        ...extra,
      }),
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'smrt-cookbook-exposure-'));
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"@fixture/bakery","version":"1.0.0","type":"module"}',
    );
    mkdirSync(join(root, 'src/lib/server'), { recursive: true });
    // Generated routes import SvelteKit and the core runtime.
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
    const dir = join(root, 'node_modules', '@test', 'commerce');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: PKG,
        version: '1.0.0',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(
      join(dir, 'dist', 'index.js'),
      'export class Order {}\nexport class Invoice {}\nexport class Ledger {}\nexport class Audit {}\nexport class Quote {}\n',
    );
    writeFileSync(
      join(dir, 'dist', 'manifest.json'),
      JSON.stringify({
        moduleType: 'smrt',
        packageName: PKG,
        objects: {
          [ref('Order')]: model('Order', 'orders', {}),
          [ref('Invoice')]: model('Invoice', 'invoices', {
            tenantScoped: { mode: 'required' },
          }),
          [ref('Ledger')]: model('Ledger', 'ledgers', { api: false }),
          [ref('Audit')]: model('Audit', 'audits', {}),
          [ref('Quote')]: model('Quote', 'quotes', {}),
        },
        recipes: [
          {
            id: 'commerce.sales',
            models: [ref('Order'), ref('Invoice'), ref('Ledger'), ref('Quote')],
            nav: [{ label: 'Orders', model: ref('Order') }],
            options: { [ref('Quote')]: { exposure: { api: false } } },
          },
        ],
      }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('resolveCookbookHostedObjects', () => {
    it('is empty without a cookbook', () => {
      expect(resolveCookbookHostedObjects(root, [PKG])).toEqual([]);
    });

    it('hosts recipe models and features, minus withdrawn ones', () => {
      writeCookbook({ features: [ref('Audit')] });
      // Quote is withdrawn by the recipe's own narrowing.
      expect(resolveCookbookHostedObjects(root, [PKG])).toEqual([
        ref('Audit'),
        ref('Invoice'),
        ref('Ledger'),
        ref('Order'),
      ]);
      writeCookbook({
        features: [ref('Audit')],
        exposure: { [ref('Audit')]: ['api', 'cli'] },
      });
      expect(resolveCookbookHostedObjects(root, [PKG])).toEqual([
        ref('Invoice'),
        ref('Ledger'),
        ref('Order'),
      ]);
    });

    it('ignores recipes and features no consumed package declares', () => {
      writeCookbook({
        recipes: ['commerce.sales', 'missing.recipe'],
        features: ['@other/pkg:Thing'],
      });
      expect(resolveCookbookHostedObjects(root, [PKG])).toEqual([
        ref('Invoice'),
        ref('Ledger'),
        ref('Order'),
      ]);
    });

    it('fails loudly on an invalid cookbook', () => {
      writeFileSync(join(root, 'smrt.cookbook.json'), '{"version": 1}');
      expect(() => resolveCookbookHostedObjects(root, [PKG])).toThrow(
        /not a valid cookbook/,
      );
    });
  });

  describe('smrt() with a cookbook and commerce in consumer.packages', () => {
    async function configure(options: Record<string, unknown> = {}) {
      const plugins = (await smrt({
        projectRoot: root,
        packages: [PKG],
        ...options,
      })) as AnyPlugin[];
      const consumer = plugins.find((p) => p.name === 'smrt-consumer');
      expect(consumer).toBeDefined();
      // One shared config object: the consumer and producer plugins coordinate
      // their route ownership through it.
      const userConfig = { root, plugins };
      const env = { command: 'build', mode: 'production' };
      for (const p of plugins) await callHook(p, 'config', userConfig, env);
      return { plugins, consumer: consumer as AnyPlugin };
    }

    it('generates routes and a definition for a listed model, and keeps api:false and unlisted models closed', async () => {
      writeCookbook();
      const { consumer } = await configure();
      const api = join(root, 'src/routes/api');

      // The Orders list and view RecipeScreens drive: GET /api/orders and /api/orders/:id.
      expect(existsSync(join(api, 'orders/+server.ts'))).toBe(true);
      expect(existsSync(join(api, 'orders/[id]/+server.ts'))).toBe(true);
      // Tenant isolation comes with the generated route for a tenant-scoped model.
      expect(readFileSync(join(api, 'invoices/+server.ts'), 'utf8')).toContain(
        'smrt-tenancy',
      );
      // api:false stays closed even though a recipe lists it.
      expect(existsSync(join(api, 'ledgers'))).toBe(false);
      // Declared in the package but not in the cookbook, or withdrawn by it.
      expect(existsSync(join(api, 'audits'))).toBe(false);
      expect(existsSync(join(api, 'quotes'))).toBe(false);

      // `@smrt/web` carries the Order definition RecipeScreens needs, at the
      // endpoint the generated route serves.
      await callHook(consumer, 'buildStart', {});
      const code = (await callHook(
        consumer,
        'load',
        '\0smrt-consumer:web',
      )) as string;
      const web = await import(
        `data:text/javascript,${encodeURIComponent(code)}`
      );
      expect(web.collectionDefinitions.orders).toMatchObject({
        objectRef: ref('Order'),
        endpoint: '/orders',
        fields: { number: { type: 'text' } },
      });
      expect(web.collectionDefinitions.ledgers).toBeUndefined();
    });

    it('serves the Orders list and a single order through the generated routes', async () => {
      writeCookbook();
      // A stand-in runtime registry: what RecipeScreens reads is the route's
      // wire shape, not the database behind it.
      const runtimeDir = join(root, 'src/server/runtime');
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, 'registry.ts'),
        `const row = (id: string, number: string) => ({
  id,
  number,
  toPublicJSON: () => ({ id, number }),
});
const rows = [row('o1', 'SO-1'), row('o2', 'SO-2')];
export async function getCollection() {
  return {
    db: (globalThis as any).__cookbookExposureDb,
    tableName: 'orders',
    list: async () => rows,
    get: async (id: string) => rows.find((r) => r.id === id) ?? null,
    count: async () => rows.length,
  };
}
`,
      );
      // The change-feed version behind the route's ETag needs a real handle.
      const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
      (globalThis as any).__cookbookExposureDb = db;
      const { plugins } = await configure({
        configPath: 'src/server/runtime',
        configFileName: 'registry.ts',
      });
      const server = await createServer({
        root,
        logLevel: 'silent',
        plugins,
        appType: 'custom',
        server: { middlewareMode: true },
      });
      try {
        const list: any = await server.ssrLoadModule(
          '/src/routes/api/orders/+server.ts',
        );
        const listed = await list.GET({
          locals: { smrtAuth: true },
          url: new URL('http://localhost/api/orders'),
          request: new Request('http://localhost/api/orders'),
        });
        expect(listed.status).toBe(200);
        const body = await listed.json();
        expect(JSON.stringify(body)).toContain('SO-1');

        const item: any = await server.ssrLoadModule(
          '/src/routes/api/orders/[id]/+server.ts',
        );
        const found = await item.GET({
          locals: { smrtAuth: true },
          params: { id: 'o2' },
          url: new URL('http://localhost/api/orders/o2'),
          request: new Request('http://localhost/api/orders/o2'),
        });
        expect(found.status).toBe(200);
        expect(JSON.stringify(await found.json())).toContain('SO-2');
      } finally {
        delete (globalThis as any).__cookbookExposureDb;
        await server.close();
        await db.close?.();
      }
    });

    it('hosts beside an app whose models are not in the default objectsDir', async () => {
      writeCookbook();
      await configure({ objectsDir: 'src/lib/models' });
      expect(existsSync(join(root, 'src/routes/api/orders/+server.ts'))).toBe(
        true,
      );
    });

    it('hosts nothing without a cookbook, and `expose` overrides the cookbook', async () => {
      await configure();
      expect(existsSync(join(root, 'src/routes/api/orders'))).toBe(false);

      writeCookbook();
      rmSync(join(root, 'src/routes'), { recursive: true, force: true });
      await configure({ expose: [ref('Audit')] });
      expect(existsSync(join(root, 'src/routes/api/audits/+server.ts'))).toBe(
        true,
      );
      expect(existsSync(join(root, 'src/routes/api/orders'))).toBe(false);
    });
  });
});
