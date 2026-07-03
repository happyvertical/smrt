/**
 * Integration coverage for the GENERATED CLIENT driven against the GENERATED
 * SERVER (#1794, #1796, #1797).
 *
 * The reference apps never caught these bugs because their pages ran on a mock
 * client — the generated `@happyvertical/smrt-virt-client` and the generated
 * `APIGenerator` server had never been exercised against each other. This suite
 * is the "one integration test suite" the #1756 spike asked for: it scans a real
 * mini-project into a genuine manifest, loads the generated client module the
 * way Vite does (through the plugin's `load` hook), and points it at a real
 * `APIGenerator` bound to an in-memory SQLite collection.
 *
 * What each concern proves:
 * - #1794: the client's URL scheme (`/<collection>`) resolves against the
 *   server's auto-discovery (no explicit `registerCollection`) — no 404 from a
 *   re-pluralized (`products` -> `productses`) segment.
 * - #1796: an error response (HTTP 500) makes the client fetcher REJECT, so an
 *   optimistic-update layer can observe the failure and roll back.
 * - #1797: the response shape the client receives matches its declared type —
 *   a BARE array for list, and snake_case `created_at` on the wire.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { APIGenerator } from '../generators/rest';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { smrtPlugin } from './index.js';

// A collection whose canonical segment is already plural
// (`GenClientProduct` -> `genclientproducts`). The generated client emits GET
// /genclientproducts; the pre-fix server re-pluralized that URL segment
// (-> `genclientproductses`) on the auto-discovery path and 404'd. Public so
// route dispatch isn't gated by auth on the integration path.
@smrt({ api: { public: true } })
class GenClientProduct extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'integer' })
  price: number = 0;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.price !== undefined) this.price = options.price;
  }
}

class GenClientProductCollection extends SmrtCollection<GenClientProduct> {
  static readonly _itemClass = GenClientProduct;
}

function getHook(plugin: any, name: string) {
  const hook = plugin[name];
  return typeof hook === 'function' ? hook : hook.handler;
}

/**
 * Shape of the runtime object the generated client module exports.
 * Each collection key exposes CRUD fetchers.
 */
interface GeneratedClient {
  [collectionKey: string]: {
    list: (params?: unknown) => Promise<unknown>;
    get: (id: string) => Promise<unknown>;
    create: (data: unknown) => Promise<unknown>;
    update: (id: string, data: unknown) => Promise<unknown>;
    delete: (id: string) => Promise<unknown>;
    search: (query: string) => Promise<unknown>;
  };
}

describe('generated client <-> generated server integration (#1794/#1796/#1797)', () => {
  let projectRoot: string;
  let clientModuleDir: string;
  let db: any;
  let collection: GenClientProductCollection;
  let createClient: (basePath?: string) => GeneratedClient;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    // Register the collection so the server can auto-discover it WITHOUT an
    // explicit registerCollection() call — the exact path #1794 broke.
    ObjectRegistry.registerCollection(
      'GenClientProduct',
      GenClientProductCollection,
    );

    // Real mini-project scanned into a genuine manifest so the generated client
    // uses the same `collection` segment the server derives.
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-gen-client-'));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'gen-client-app',
        version: '0.0.1',
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'src', 'objects.ts'),
      `import { SmrtObject } from '@happyvertical/smrt-core';

@smrt({ api: { public: true } })
export class GenClientProduct extends SmrtObject {
  name: string = '';
  price: number = 0;
}
`,
    );

    const plugin: any = smrtPlugin({
      generateTypes: false,
      include: ['src/**/*.ts'],
    });
    await plugin.configResolved?.call(plugin, {
      root: projectRoot,
      mode: 'production',
      plugins: [],
      build: {},
    } as any);

    const load = getHook(plugin, 'load').bind(plugin);
    const clientSource = (await load('\0smrt:client')) as string;
    // The client key is the manifest `collection` segment. `GenClientProduct`
    // pluralizes to `genclientproducts`; assert that here so a future
    // inflection change surfaces as a readable failure rather than an
    // `undefined.list()` TypeError below.
    expect(clientSource).toContain('genclientproducts:');

    // Evaluate the generated ESM the way a bundler would: write it to disk and
    // dynamic-import it. This exercises the ACTUAL emitted source, not a
    // hand-rolled reimplementation.
    clientModuleDir = mkdtempSync(join(tmpdir(), 'smrt-gen-client-mod-'));
    const clientModulePath = join(clientModuleDir, 'client.mjs');
    writeFileSync(clientModulePath, clientSource, 'utf-8');
    const mod = await import(pathToFileURL(clientModulePath).href);
    createClient = mod.createClient;

    // Real in-memory SQLite collection + generated server. No registerCollection
    // on the APIGenerator — force the auto-discovery path.
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['GenClientProduct'],
    });
    collection = await GenClientProductCollection.create({ db });
    const api = new APIGenerator({ basePath: '/api/v1' }, { db });
    handler = api.generateHandler();
  }, 60_000);

  afterAll(async () => {
    await db?.close?.();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    if (clientModuleDir)
      rmSync(clientModuleDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Route the generated client's `fetch(url, init)` calls into the generated
   * server's request handler. This is what wires CLIENT -> SERVER in-process.
   */
  function stubFetchToServer(
    routeHandler: (req: Request) => Promise<Response>,
  ): void {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input.startsWith('http')
            ? input
            : `http://local${input}`
          : input.toString();
      return routeHandler(new Request(url, init));
    });
  }

  it('#1794: generated client list() URL resolves against server auto-discovery (no 404)', async () => {
    // Seed a row so a resolved route returns data.
    const seeded = await collection.create({ name: 'Widget', price: 5 });
    await seeded.save();

    stubFetchToServer(handler);
    const client = createClient('/api/v1');

    // The generated client uses the manifest `collection` segment (`products`);
    // the server must resolve that same segment. Pre-fix, auto-discovery
    // re-pluralized and returned 404 -> the client received the {error} body.
    const result = await client.genclientproducts.list();

    expect(Array.isArray(result)).toBe(true);
    const rows = result as Array<Record<string, unknown>>;
    // A 404 would have surfaced `{ error: "Object type '...' not found" }`,
    // which is NOT an array of products.
    expect(rows.some((r) => r.name === 'Widget')).toBe(true);
  });

  it('#1797: list() returns a BARE array whose items carry snake_case created_at', async () => {
    stubFetchToServer(handler);
    const client = createClient('/api/v1');

    const result = await client.genclientproducts.list();
    expect(Array.isArray(result)).toBe(true); // bare array, not { data: [...] }

    const rows = result as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    // Wire field naming is snake_case (matches toJSON()/toPublicJSON()).
    expect(row).toHaveProperty('created_at');
    expect(row).not.toHaveProperty('createdAt');
  });

  it('#1794/#1797: create() then get() round-trips through the generated client', async () => {
    stubFetchToServer(handler);
    const client = createClient('/api/v1');

    const created = (await client.genclientproducts.create({
      name: 'Gadget',
      price: 12,
    })) as Record<string, unknown>;
    expect(created).toHaveProperty('id');
    expect(created.name).toBe('Gadget');
    expect(created).toHaveProperty('created_at');

    const fetched = (await client.genclientproducts.get(
      created.id as string,
    )) as Record<string, unknown>;
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe('Gadget');
  });

  it('#1796: a 500 response makes the generated client REJECT (optimistic rollback can observe it)', async () => {
    // A server that always 500s — models a failing mutation.
    const failing: (req: Request) => Promise<Response> = async () =>
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    stubFetchToServer(failing);
    const client = createClient('/api/v1');

    // An optimistic-update layer applies its change, then awaits the mutation;
    // if the promise resolves on a 500 the rollback can never fire. Assert it
    // rejects instead.
    let rolledBack = false;
    await expect(
      client.genclientproducts
        .create({ name: 'DoomedGadget', price: 1 })
        .catch((err) => {
          rolledBack = true;
          throw err;
        }),
    ).rejects.toBeDefined();
    expect(rolledBack).toBe(true);
  });
});
