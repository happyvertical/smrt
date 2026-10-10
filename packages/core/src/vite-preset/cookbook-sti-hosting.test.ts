/**
 * Hosting STI siblings of a consumed package (#3749): each hosted subclass
 * gets its own route collection, the `@smrt/web` definition advertises the
 * endpoint that route serves, a subclass list is scoped to its own rows and the
 * base list keeps the base-collection semantics.
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
import type { DatabaseInterface } from '@happyvertical/sql';
import { createServer, type Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { separateHostedStiCollections } from '../consumer-plugin/hosted-sti-collections.js';
import { SmrtObject, smrt } from '../index.js';
import { getTestDatabase } from '../testing/database.js';
import { smrt as smrtPreset } from './index.js';

type AnyPlugin = Plugin & Record<string, any>;

const PKG = '@test/docs';
const ref = (model: string) => `${PKG}:${model}`;

@smrt({ tableStrategy: 'sti', idType: 'text' })
class StiDoc extends SmrtObject {
  title: string = '';
}

@smrt()
class StiInvoice extends StiDoc {
  total: string = '';
}

@smrt()
class StiReceipt extends StiDoc {
  method: string = '';
}

class DocCollection extends SmrtCollection<StiDoc> {
  static readonly _itemClass = StiDoc;
}
class InvoiceCollection extends SmrtCollection<StiInvoice> {
  static readonly _itemClass = StiInvoice;
}
class ReceiptCollection extends SmrtCollection<StiReceipt> {
  static readonly _itemClass = StiReceipt;
}

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

/** A manifest entry as the package build writes it for an STI subclass. */
const stiChild = (className: string, decoratorConfig: object = {}) => ({
  className,
  qualifiedName: ref(className),
  packageName: PKG,
  collection: (decoratorConfig as { collection?: string }).collection ?? 'docs',
  extends: 'Doc',
  fields: { title: { type: 'text' } },
  methods: {},
  decoratorConfig: {
    tableName: 'docs',
    tableStrategy: 'sti',
    ...decoratorConfig,
  },
});

const manifestObjects = () => ({
  [ref('Doc')]: {
    className: 'Doc',
    qualifiedName: ref('Doc'),
    packageName: PKG,
    collection: 'docs',
    fields: { title: { type: 'text' } },
    methods: {},
    // Like `Contract`: no delete.
    decoratorConfig: {
      tableStrategy: 'sti',
      api: { include: ['list', 'get', 'create', 'update'] },
    },
  },
  [ref('Invoice')]: stiChild('Invoice'),
  // Declares its own api, which wins over the base's.
  [ref('Receipt')]: stiChild('Receipt', {
    api: { include: ['list', 'get', 'delete'] },
  }),
  // Declares an independent route collection of its own.
  [ref('Memo')]: stiChild('Memo', { collection: 'memos' }),
  [ref('Note')]: {
    className: 'Note',
    qualifiedName: ref('Note'),
    packageName: PKG,
    collection: 'notes',
    fields: { title: { type: 'text' } },
    methods: {},
    decoratorConfig: {},
  },
});

describe('separateHostedStiCollections', () => {
  const manifest = { version: '1', objects: manifestObjects() };
  const refOf = (key: string) => key;

  it('moves only hosted, collection-inheriting STI subclasses', () => {
    const next = separateHostedStiCollections(
      manifest,
      [ref('Invoice'), ref('Receipt'), ref('Memo'), ref('Note')],
      refOf,
    ) as typeof manifest;
    const c = (name: string) => (next.objects as any)[ref(name)].collection;
    expect(c('Invoice')).toBe('invoices');
    expect(c('Receipt')).toBe('receipts');
    // A declared collection, a plain model and the base are left alone.
    expect(c('Memo')).toBe('memos');
    expect(c('Note')).toBe('notes');
    expect(c('Doc')).toBe('docs');
    // The input is not mutated.
    expect((manifest.objects as any)[ref('Invoice')].collection).toBe('docs');
  });

  it('leaves the base and unhosted siblings on the shared collection', () => {
    const next = separateHostedStiCollections(
      manifest,
      [ref('Doc'), ref('Invoice')],
      refOf,
    ) as typeof manifest;
    expect((next.objects as any)[ref('Doc')].collection).toBe('docs');
    expect((next.objects as any)[ref('Receipt')].collection).toBe('docs');
    expect((next.objects as any)[ref('Invoice')].collection).toBe('invoices');
  });

  it('lends a subclass that declares no api its STI base api', () => {
    const next = separateHostedStiCollections(
      manifest,
      [ref('Invoice'), ref('Receipt'), ref('Memo')],
      refOf,
    ) as typeof manifest;
    const api = (name: string) =>
      (next.objects as any)[ref(name)].decoratorConfig.api;
    expect(api('Invoice')).toEqual({
      include: ['list', 'get', 'create', 'update'],
    });
    // Explicit config wins, including on a subclass with its own collection.
    expect(api('Receipt')).toEqual({ include: ['list', 'get', 'delete'] });
    expect(api('Memo')).toEqual({
      include: ['list', 'get', 'create', 'update'],
    });
    // The input is not mutated and a plain model is untouched.
    expect(
      (manifest.objects as any)[ref('Invoice')].decoratorConfig.api,
    ).toBeUndefined();
    expect((next.objects as any)[ref('Note')]).toBe(
      (manifest.objects as any)[ref('Note')],
    );
  });

  it('returns the manifest itself when nothing needs separating', () => {
    expect(separateHostedStiCollections(manifest, [ref('Doc')], refOf)).toBe(
      manifest,
    );
  });
});

describe('cookbook hosting of STI siblings (#3749)', () => {
  let root: string;
  let db: DatabaseInterface | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'smrt-cookbook-sti-'));
    writeFileSync(
      join(root, 'package.json'),
      '{"name":"@fixture/bakery","version":"1.0.0","type":"module"}',
    );
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
    const dir = join(root, 'node_modules', '@test', 'docs');
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
      ['Doc', 'Invoice', 'Receipt', 'Memo', 'Note']
        .map((n) => `export class ${n} {}`)
        .join('\n'),
    );
    writeFileSync(
      join(dir, 'dist', 'manifest.json'),
      JSON.stringify({
        moduleType: 'smrt',
        packageName: PKG,
        objects: manifestObjects(),
        recipes: [
          {
            id: 'docs.main',
            models: [ref('Invoice'), ref('Receipt'), ref('Note')],
            nav: [{ label: 'Invoices', model: ref('Invoice') }],
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  const writeCookbook = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(root, 'smrt.cookbook.json'),
      JSON.stringify({
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
        version: 1,
        recipes: ['docs.main'],
        features: [],
        policies: [],
        ...extra,
      }),
    );

  async function configure(options: Record<string, unknown> = {}) {
    const plugins = (await smrtPreset({
      projectRoot: root,
      packages: [PKG],
      ...options,
    })) as AnyPlugin[];
    const userConfig = { root, plugins };
    const env = { command: 'build', mode: 'production' };
    for (const p of plugins) await callHook(p, 'config', userConfig, env);
    return plugins;
  }

  async function webDefinitions(plugins: AnyPlugin[]) {
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
    return web.collectionDefinitions as Record<string, any>;
  }

  it('gives each hosted subclass its own route and web definition', async () => {
    writeCookbook();
    const plugins = await configure();
    const api = join(root, 'src/routes/api');

    expect(existsSync(join(api, 'invoices/+server.ts'))).toBe(true);
    expect(existsSync(join(api, 'invoices/[id]/+server.ts'))).toBe(true);
    expect(existsSync(join(api, 'receipts/+server.ts'))).toBe(true);
    expect(existsSync(join(api, 'notes/+server.ts'))).toBe(true);
    // The shared collection is not hosted: the base is not on the allowlist.
    expect(existsSync(join(api, 'docs'))).toBe(false);
    // Each handler reads through its own class's collection.
    expect(readFileSync(join(api, 'invoices/+server.ts'), 'utf8')).toMatch(
      /getCollection<Invoice>\(\s*'@test\/docs:Invoice'/,
    );
    expect(readFileSync(join(api, 'receipts/+server.ts'), 'utf8')).toMatch(
      /getCollection<Receipt>\(\s*'@test\/docs:Receipt'/,
    );

    // The definition a screen reads for a model advertises that route.
    const defs = await webDefinitions(plugins);
    expect(defs.invoices).toMatchObject({
      objectRef: ref('Invoice'),
      endpoint: '/invoices',
    });
    expect(defs.receipts).toMatchObject({
      objectRef: ref('Receipt'),
      endpoint: '/receipts',
    });
    expect(defs.notes).toMatchObject({ endpoint: '/notes' });
  });

  it('fails closed: a subclass inherits its base api, an explicit one wins', async () => {
    writeCookbook();
    await configure();
    const api = join(root, 'src/routes/api');
    const detail = (dir: string) =>
      readFileSync(join(api, dir, '[id]/+server.ts'), 'utf8');
    // Doc allows no delete, so the Invoice route accepts no DELETE.
    expect(detail('invoices')).not.toMatch(
      /export (const|async function) DELETE/,
    );
    expect(detail('invoices')).toMatch(
      /export (const|async function) PUT|PATCH/,
    );
    // Receipt declares delete itself.
    expect(detail('receipts')).toMatch(/export (const|async function) DELETE/);
    // A plain model keeps the framework default (full CRUD).
    expect(detail('notes')).toMatch(/export (const|async function) DELETE/);
  });

  it('keeps a hosted base on the shared collection beside its subclasses', async () => {
    writeCookbook({ features: [ref('Doc')] });
    const plugins = await configure();
    const api = join(root, 'src/routes/api');
    for (const dir of ['docs', 'invoices', 'receipts']) {
      expect(existsSync(join(api, dir, '+server.ts'))).toBe(true);
    }
    const defs = await webDefinitions(plugins);
    expect(defs.docs).toMatchObject({
      objectRef: ref('Doc'),
      endpoint: '/docs',
    });
    expect(defs.invoices.endpoint).toBe('/invoices');
  });

  it('honours a collection the subclass declares', async () => {
    writeCookbook({ features: [ref('Memo')] });
    await configure();
    const api = join(root, 'src/routes/api');
    expect(existsSync(join(api, 'memos/+server.ts'))).toBe(true);
    expect(existsSync(join(api, 'docs'))).toBe(false);
  });

  it('lists a subclass from its own rows and the base from all of them', async () => {
    writeCookbook({ features: [ref('Doc')] });
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['StiDoc', 'StiInvoice', 'StiReceipt'],
    });
    const invoices = await InvoiceCollection.create({ db });
    const receipts = await ReceiptCollection.create({ db });
    const docs = await DocCollection.create({ db });
    const inv1 = await invoices.create({ title: 'INV-1', total: '10' });
    const inv2 = await invoices.create({ title: 'INV-2', total: '20' });
    const rct1 = await receipts.create({ title: 'RCT-1', method: 'cash' });
    (globalThis as any).__stiHosting = {
      Doc: docs,
      Invoice: invoices,
      Receipt: receipts,
    };

    const runtimeDir = join(root, 'src/server/runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'registry.ts'),
      `export async function getCollection(name: string) {
  return (globalThis as any).__stiHosting[name.split(':').pop()!];
}
`,
    );
    const plugins = await configure({
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
    const ids = async (segment: string) => {
      const mod: any = await server.ssrLoadModule(
        `/src/routes/api/${segment}/+server.ts`,
      );
      const url = `http://localhost/api/${segment}`;
      const response = await mod.GET({
        locals: { smrtAuth: true },
        url: new URL(url),
        request: new Request(url),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      return (Array.isArray(body) ? body : (body.items ?? body.data))
        .map((row: any) => row.id)
        .sort();
    };
    try {
      expect(await ids('invoices')).toEqual([inv1.id, inv2.id].sort());
      expect(await ids('receipts')).toEqual([rct1.id]);
      expect(await ids('docs')).toEqual([inv1.id, inv2.id, rct1.id].sort());
    } finally {
      delete (globalThis as any).__stiHosting;
      await server.close();
    }
  });
});
