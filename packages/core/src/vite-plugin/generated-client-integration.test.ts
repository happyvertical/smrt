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

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { parseRestListWhere } from '../query-access';
import { ObjectRegistry, smrt } from '../registry';
import type { SmartObjectManifest } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';
import { generateTypeDeclarationFile, smrtPlugin } from './index.js';

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

  @field({ type: 'boolean' })
  featured: boolean = false;

  @field({ type: 'datetime' })
  releasedAt: Date | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.price !== undefined) this.price = options.price;
    if (options.featured !== undefined) this.featured = options.featured;
    if (options.releasedAt !== undefined) this.releasedAt = options.releasedAt;
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
  let clientSource = '';
  let declarationSource = '';

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
        name: '@fixture/gen-client-app',
        version: '0.0.1',
        type: 'module',
      }),
    );
    writeFileSync(
      join(projectRoot, 'src', 'objects.ts'),
      `import { field, SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';

@smrt({
  api: {
    public: true,
    routes: {
      findFeatured: { method: 'GET' },
      invalidItemScope: { scope: 'item' },
    },
  },
})
export class GenClientProductCollection extends SmrtCollection<GenClientProduct> {
  static readonly _itemClass = GenClientProduct;

  async list(): Promise<GenClientProduct[]> {
    return super.list();
  }

  async findFeatured(options: { category?: string } = {}): Promise<GenClientProduct[]> {
    return this.list({ where: { featured: true, ...options } });
  }

  async search(filters: { term?: string } = {}): Promise<GenClientProduct[]> {
    return this.list({ where: filters });
  }

  async invalidItemScope(): Promise<GenClientProduct[]> {
    return this.list();
  }

  async bulkReindex(
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<GenClientProduct[]> {
    return this.list();
  }
}

@smrt({
  api: {
    public: true,
    routes: { invalidCollectionScope: { scope: 'collection' } },
  },
})
export class GenClientProduct extends SmrtObject {
  @field({ type: 'text', required: true })
  name: string = '';

  @field({ type: 'integer', required: true })
  price: number = 0;

  async invalidCollectionScope(): Promise<GenClientProduct> {
    return this;
  }
}

@smrt({
  api: {
    public: true,
    routes: {
      describe: { path: 'descriptions/[tone]' },
      caption: { path: 'captions/[toString]' },
      glance: { method: 'GET', path: 'glances/[tone]' },
    },
  },
})
export class ArtCollection extends SmrtObject {
  async glance(tone: string): Promise<string> {
    return tone;
  }

  async describe(tone: string): Promise<string> {
    void tone;
    return 'item model, not SmrtCollection';
  }

  async caption(toString: string): Promise<string> {
    return toString;
  }
}

@smrt({ api: { public: true } })
export class Contents extends SmrtCollection<Content> {
  async featured(): Promise<Content[]> {
    return this.list();
  }
}

@smrt({ api: { public: true } })
export class Content extends SmrtObject {
  async summarize(): Promise<string> {
    return 'summary';
  }
}

@smrt({ api: { public: true } })
export class GenClientMessageCollection extends SmrtCollection<GenClientMessage> {}

@smrt({ api: { public: true } })
export class GenClientEmailCollection extends GenClientMessageCollection {
  async findUnread(): Promise<GenClientEmail[]> {
    return this.list();
  }
}

@smrt({ api: { public: true } })
export class GenClientMessage extends SmrtObject {}

@smrt({ api: { public: true } })
export class GenClientEmail extends GenClientMessage {}

@smrt({ api: { public: true } })
export class GenClientSecretCollection extends SmrtCollection<GenClientSecret> {
  async reveal(): Promise<string> {
    return 'revealed';
  }
}

@smrt({ api: false })
export class GenClientSecret extends SmrtObject {
  @field({ type: 'text' })
  value: string = '';
}

@smrt({ api: { public: true, include: ['get', 'ping'] } })
export class GenClientReadonly extends SmrtObject {
  async ping(): Promise<string> {
    return 'pong';
  }
}

`,
    );

    const plugin: any = smrtPlugin({
      generateTypes: true,
      include: ['src/**/*.ts'],
      watch: false,
    });
    await plugin.configResolved?.call(plugin, {
      root: projectRoot,
      mode: 'production',
      plugins: [],
      build: {},
    } as any);
    getHook(plugin, 'configureServer').call(plugin, {
      config: { root: projectRoot },
      middlewares: { use: vi.fn() },
    });
    await getHook(plugin, 'buildStart').call(plugin);

    const load = getHook(plugin, 'load').bind(plugin);
    clientSource = (await load('\0smrt:client')) as string;
    declarationSource = readFileSync(
      join(projectRoot, 'src', 'types', 'virtual-modules.d.ts'),
      'utf-8',
    );

    // Evaluate the generated ESM the way a bundler would: write it to disk and
    // dynamic-import it. This exercises the ACTUAL emitted source, not a
    // hand-rolled reimplementation. Source-shape assertions live in their own
    // test so a behavioural regression fails at its own assertion.
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

  it('emits every fetcher async with the route signature its manifest declares', () => {
    expect(Object.keys(createClient().genclientsecrets)).toEqual(['reveal']);
    // The client key is the manifest `collection` segment. `GenClientProduct`
    // pluralizes to `genclientproducts`; assert that here so a future
    // inflection change surfaces as a readable failure.
    expect(clientSource).toContain('"genclientproducts":');
    expect(clientSource).toContain('"genClientProductCollection":');
    expect(clientSource.match(/\n {2}"genclientproducts":/g)).toHaveLength(1);
    expect(clientSource.match(/\n {2}"contents":/g)).toHaveLength(1);
    expect(clientSource).toContain('"contents2":');
    expect(clientSource).toContain('findFeatured: async (options)');
    expect(clientSource).not.toContain('findFeatured: async (id, options)');
    expect(clientSource).not.toContain('list: async (id, options)');
    expect(clientSource).toContain('invalidItemScope: async (options)');
    expect(clientSource).not.toContain('invalidItemScope: async (id, options)');
    expect(clientSource).toContain(
      'invalidCollectionScope: async (id, options)',
    );
    expect(clientSource).not.toContain(
      'invalidCollectionScope: async (options)',
    );
    expect(clientSource).toContain('describe: async (id, options)');
    expect(clientSource).not.toContain('describe: async (options)');
    expect(clientSource).toContain('caption: async (id, options)');
    expect(clientSource).toContain('featured: async (options)');
    expect(clientSource).toContain('summarize: async (id, options)');
    expect(clientSource).toContain('findUnread: async (options)');
    expect(clientSource).not.toContain('findUnread: async (id, options)');
    const customOnlyClientSource = clientSource.match(
      /\n {2}"genclientsecrets": \{([\s\S]*?)\n {2}\}/,
    )?.[1];
    expect(customOnlyClientSource).toContain('reveal: async (options)');
    expect(customOnlyClientSource).not.toMatch(
      /\b(list|get|create|update|delete|search):/,
    );
    const partialClientSource = clientSource.match(
      /\n {2}"genclientreadonlies": \{([\s\S]*?)\n {2}\}/,
    )?.[1];
    expect(partialClientSource).toContain('get: async (id)');
    expect(partialClientSource).toContain('ping: async (id, options)');
    expect(partialClientSource).not.toMatch(
      /\b(list|create|update|delete|search):/,
    );
    expect(declarationSource).toContain(
      '"genclientproducts": CrudOperations<import(\'@happyvertical/smrt-virt-types\').GenClientProductData> & {\n      invalidCollectionScope(id: string, options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).not.toContain(
      '"genclientproducts": CrudOperations<import(\'@happyvertical/smrt-virt-types\').GenClientProductCollectionData>;',
    );
    expect(declarationSource).toContain(
      '"genClientProductCollection": Pick<CrudOperations<import(\'@happyvertical/smrt-virt-types\').GenClientProductData>, "list" | "get" | "create" | "update" | "delete"> & {',
    );
    expect(declarationSource).toMatch(
      /export interface GenClientProductData \{[\s\S]*?name: string;[\s\S]*?price: number;[\s\S]*?\n {2}\}/,
    );
    expect(declarationSource).toContain(
      'invalidItemScope(options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      'invalidCollectionScope(id: string, options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      'findFeatured(options?: Record<string, any>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      'bulkReindex(options: { idempotencyKey: string; expectedVersion?: number }): Promise<any>;',
    );
    expect(declarationSource).toContain(
      'describe(id: string, options: { tone: string }): Promise<any>;',
    );
    expect(declarationSource).toContain(
      '"contents": CrudOperations<import(\'@happyvertical/smrt-virt-types\').ContentData> & {\n      summarize(id: string, options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      '"contents2": CrudOperations<import(\'@happyvertical/smrt-virt-types\').ContentData> & {\n      featured(options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      '"genClientEmailCollection": CrudOperations<import(\'@happyvertical/smrt-virt-types\').GenClientMessageData> & {\n      findUnread(options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      '"genclientsecrets": {\n      reveal(options?: Record<string, never>): Promise<any>;\n    };',
    );
    expect(declarationSource).not.toContain(
      '"genclientsecrets": CrudOperations<import(\'@happyvertical/smrt-virt-types\').GenClientSecretData>',
    );
    expect(declarationSource).toContain(
      '"genclientreadonlies": Pick<CrudOperations<import(\'@happyvertical/smrt-virt-types\').GenClientReadonlyData>, "get"> & {\n      ping(id: string, options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain('error?: string | SmrtClientFailure;');
    expect(declarationSource).toContain('code?: string;');
  });

  afterAll(async () => {
    await db?.close?.();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
    if (clientModuleDir)
      rmSync(clientModuleDir, { recursive: true, force: true });
  });

  it('quotes non-identifier keys in Vite client and web declarations', async () => {
    const declarationRoot = mkdtempSync(join(tmpdir(), 'smrt-vite-types-'));
    try {
      const manifest: SmartObjectManifest = {
        version: '1.0.0',
        timestamp: 1,
        objects: {
          AuditEvent: {
            className: 'AuditEvent',
            name: 'AuditEvent',
            filePath: '',
            collection: 'audit-events',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      };

      await generateTypeDeclarationFile(manifest, declarationRoot, 'types');
      const declarationSource = readFileSync(
        join(declarationRoot, 'types', 'virtual-modules.d.ts'),
        'utf-8',
      );
      expect(declarationSource).toContain(
        '"audit-events": CrudOperations<import(\'@happyvertical/smrt-virt-types\').AuditEventData>;',
      );
      expect(declarationSource).toContain(
        '"audit-events": SmrtWebCollectionDefinition<',
      );
      expect(declarationSource).toContain('objectRef: string;');
    } finally {
      rmSync(declarationRoot, { force: true, recursive: true });
    }
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

  it('uses collection-scoped URLs and configured verbs for generated collection methods', async () => {
    const collectionHandler = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe('/api/v1/genclientproducts/findFeatured');
      expect(url.searchParams.get('category')).toBe('news');
      expect(req.method).toBe('GET');
      expect(await req.text()).toBe('');
      return Response.json({
        action: 'findFeatured',
        result: [{ name: 'Featured widget' }],
      });
    });
    stubFetchToServer(collectionHandler);

    const client = createClient('/api/v1');
    const collectionClient =
      client.genClientProductCollection as typeof client.genClientProductCollection & {
        findFeatured(options?: Record<string, unknown>): Promise<unknown>;
      };
    const result = await collectionClient.findFeatured({ category: 'news' });

    expect(result).toEqual([{ name: 'Featured widget' }]);
    expect(collectionHandler).toHaveBeenCalledOnce();
  });

  it('preserves custom collection search methods instead of masking them with the generic fetcher', async () => {
    const collectionHandler = vi.fn(async (req: Request) => {
      expect(new URL(req.url).pathname).toBe(
        '/api/v1/genclientproducts/search',
      );
      expect(req.method).toBe('POST');
      expect(await req.json()).toEqual({ filters: { term: 'widget' } });
      return Response.json({
        action: 'search',
        result: [{ name: 'Widget' }],
      });
    });
    stubFetchToServer(collectionHandler);

    const client = createClient('/api/v1');
    const collectionClient =
      client.genClientProductCollection as typeof client.genClientProductCollection & {
        search(options?: Record<string, unknown>): Promise<unknown>;
      };
    const result = await collectionClient.search({
      filters: { term: 'widget' },
    });

    expect(result).toEqual([{ name: 'Widget' }]);
    expect(collectionHandler).toHaveBeenCalledOnce();
  });

  it('#1797: list() returns a BARE array whose items carry snake_case created_at', async () => {
    // Seed this test's own row so the assertion doesn't depend on test order.
    const seeded = await collection.create({ name: 'Sprocket', price: 3 });
    await seeded.save();

    stubFetchToServer(handler);
    const client = createClient('/api/v1');

    const result = await client.genclientproducts.list();
    expect(Array.isArray(result)).toBe(true); // bare array, not { data: [...] }

    const rows = result as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.find((r) => r.name === 'Sprocket') as Record<
      string,
      unknown
    >;
    expect(row).toBeDefined();
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

  it('#1796: a 500 response rejects opaquely so optimistic rollback can observe it', async () => {
    // A server that always 500s — models a failing mutation.
    const failing: (req: Request) => Promise<Response> = async () =>
      new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    stubFetchToServer(failing);
    const client = createClient('/api/v1');

    // An optimistic-update layer applies its change, then awaits the mutation;
    // if the promise resolves on a 500 the rollback can never fire. Server
    // failure detail is deliberately opaque because an upstream 5xx body may
    // contain sensitive internals.
    let rolledBack = false;
    const error = await client.genclientproducts
      .create({ name: 'DoomedGadget', price: 1 })
      .catch((err) => {
        rolledBack = true;
        return err;
      });
    expect(rolledBack).toBe(true);
    expect(error).toMatchObject({ name: 'SmrtClientError', status: 500 });
    expect((error as Error).message).not.toContain('boom');
    expect(error).not.toHaveProperty('body');
    expect(error).not.toHaveProperty('code');
  });

  it('preserves structured custom-action failures without stringifying their error object', async () => {
    const failure = {
      ok: false,
      code: 'policy_locked',
      message: 'This policy is locked by your organization',
      status: 403,
    };
    stubFetchToServer(async () =>
      Response.json({ error: failure }, { status: 403 }),
    );
    const client = createClient('/api/v1');

    await expect(client.genclientproducts.list()).rejects.toMatchObject({
      name: 'SmrtClientError',
      status: 403,
      code: 'policy_locked',
      body: { error: failure },
    });
    await client.genclientproducts.list().catch((error: Error) => {
      expect(error.message).toContain(failure.message);
      expect(error.message).not.toContain('[object Object]');
    });
  });

  /** Record the exact URL string each generated fetcher passes to `fetch`. */
  function recordRequestedUrls(): string[] {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      urls.push(String(input));
      return Response.json({ id: 'recorded', result: 'ok' });
    });
    return urls;
  }

  it('sends a caller-supplied id as one encoded path segment for get, update, delete and item actions', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const id = 'a/../b?x=1#frag';
    const encoded = encodeURIComponent(id);

    await client.genclientproducts.get(id);
    await client.genclientproducts.update(id, { name: 'Renamed' });
    await client.genclientproducts.delete(id);
    const readonlyClient = client.genclientreadonlies as unknown as {
      ping(id: string, options?: Record<string, never>): Promise<unknown>;
    };
    await readonlyClient.ping(id);

    expect(urls).toEqual([
      `/api/v1/genclientproducts/${encoded}`,
      `/api/v1/genclientproducts/${encoded}`,
      `/api/v1/genclientproducts/${encoded}`,
      `/api/v1/genclientreadonlies/${encoded}/ping`,
    ]);
    // Resolved against an origin, the request stays on its collection route.
    for (const url of urls) {
      const { pathname } = new URL(url, 'http://local');
      expect(pathname.split('/').slice(0, 5)).toEqual([
        '',
        'api',
        'v1',
        pathname.split('/')[3],
        encoded,
      ]);
    }
  });

  it('encodes a percent sign in an id instead of passing an escape through', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');

    await client.genclientproducts.get('a%2F..%2Fb');

    expect(urls).toEqual(['/api/v1/genclientproducts/a%252F..%252Fb']);
    expect(
      decodeURIComponent(
        new URL(urls[0], 'http://local').pathname.split('/')[4],
      ),
    ).toBe('a%2F..%2Fb');
  });

  it('keeps ordinary ids unchanged in item URLs', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');

    await client.genclientproducts.get('3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f');

    expect(urls).toEqual([
      '/api/v1/genclientproducts/3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f',
    ]);
  });

  it('still sends a request for an id it sent one for before, now encoded', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');

    await client.genclientproducts.get(undefined as unknown as string);
    await client.genclientproducts.get(42 as unknown as string);

    expect(urls).toEqual([
      '/api/v1/genclientproducts/undefined',
      '/api/v1/genclientproducts/42',
    ]);
  });

  it('rejects, without throwing or sending, an id that cannot be encoded', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const loneSurrogate = 'a\uD800b';

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = client.genclientproducts.get(loneSurrogate);
    }).not.toThrow();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(
      /Invalid generated client route parameter id/,
    );
    await expect(
      client.genclientproducts.update(loneSurrogate, {}),
    ).rejects.toThrow(/Invalid generated client route parameter id/);
    const art = client.artcollections as unknown as {
      describe(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };
    await expect(art.describe(loneSurrogate, { tone: 'warm' })).rejects.toThrow(
      /Invalid generated client route parameter id/,
    );
    expect(urls).toEqual([]);
  });

  it('rejects with URIError, rather than throws, for a named route parameter that cannot be encoded', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const art = client.artcollections as unknown as {
      describe(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };

    const pending = art.describe('1', { tone: 'a\uD800b' });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(URIError);
    expect(urls).toEqual([]);
  });

  it('encodes a value that looks like a route placeholder as data', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const art = client.artcollections as unknown as {
      describe(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };

    await art.describe('[tone]', { tone: '[tone]' });

    expect(urls).toEqual([
      '/api/v1/artcollections/%5Btone%5D/descriptions/%5Btone%5D',
    ]);
  });

  it('refuses an empty, "." or ".." id before any request is sent', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');

    for (const id of ['', '.', '..']) {
      await expect(client.genclientproducts.get(id)).rejects.toThrow(
        /Invalid generated client route parameter id/,
      );
      await expect(client.genclientproducts.delete(id)).rejects.toThrow(
        /Invalid generated client route parameter id/,
      );
    }
    expect(urls).toEqual([]);
  });

  it('list() forwards its params as query parameters', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');

    await client.genclientproducts.list({
      limit: 1,
      offset: 2,
      name: 'Widget',
      unset: undefined,
    });
    await client.genclientproducts.list();

    expect(urls).toEqual([
      '/api/v1/genclientproducts?limit=1&offset=2&name=Widget',
      '/api/v1/genclientproducts',
    ]);
  });

  it('list() params narrow the rows the server returns', async () => {
    for (const name of ['Limited A', 'Limited B']) {
      const row = await collection.create({ name, price: 7 });
      await row.save();
    }
    stubFetchToServer(handler);
    const client = createClient('/api/v1');

    const page = (await client.genclientproducts.list({
      price: 7,
      limit: 1,
    })) as Array<Record<string, unknown>>;
    const all = (await client.genclientproducts.list({
      price: 7,
    })) as Array<Record<string, unknown>>;

    expect(page).toHaveLength(1);
    expect(all.map((row) => row.name).sort()).toEqual([
      'Limited A',
      'Limited B',
    ]);
  });

  it('rejects, rather than throws, when a named route parameter is missing', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const art = client.artcollections as unknown as {
      describe(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = art.describe('1', {});
    }).not.toThrow();
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow(
      /Missing generated client route parameter: tone/,
    );
    expect(urls).toEqual([]);
  });

  it('treats a named route parameter that is not an own property as missing', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const art = client.artcollections as unknown as {
      caption(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };

    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = art.caption('1', {});
    }).not.toThrow();
    await expect(pending).rejects.toThrow(
      /Missing generated client route parameter: toString/,
    );
    await expect(
      art.caption('1', Object.create({ toString: 'inherited' })),
    ).rejects.toThrow(/Missing generated client route parameter: toString/);
    expect(urls).toEqual([]);

    // An own property is used, and read exactly once.
    let reads = 0;
    const options = {};
    // Not enumerable, so the request body does not read it too.
    Object.defineProperty(options, 'toString', {
      enumerable: false,
      get() {
        reads += 1;
        return reads === 1 ? 'short' : '..';
      },
    });
    await art.caption('1', options);
    expect(reads).toBe(1);
    expect(urls).toEqual(['/api/v1/artcollections/1/captions/short']);
  });

  it('reads an enumerable named route parameter once and sends that value in the body or query', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: init?.body });
      return Response.json({ result: 'ok' });
    });
    const client = createClient('/api/v1');
    const art = client.artcollections as unknown as {
      caption(id: string, options?: Record<string, unknown>): Promise<unknown>;
      glance(id: string, options?: Record<string, unknown>): Promise<unknown>;
    };
    const countingOptions = (name: string) => {
      const state = { reads: 0 };
      const options: Record<string, unknown> = { extra: 'kept' };
      Object.defineProperty(options, name, {
        enumerable: true,
        get() {
          state.reads += 1;
          return state.reads === 1 ? 'first' : 'later';
        },
      });
      return { options, state };
    };

    const post = countingOptions('toString');
    await art.caption('1', post.options);
    expect(post.state.reads).toBe(1);
    expect(requests[0].url).toBe('/api/v1/artcollections/1/captions/first');
    expect(JSON.parse(String(requests[0].body))).toEqual({
      extra: 'kept',
      toString: 'first',
    });

    const get = countingOptions('tone');
    await art.glance('1', get.options);
    expect(get.state.reads).toBe(1);
    expect(requests[1].url).toBe(
      '/api/v1/artcollections/1/glances/first?extra=kept',
    );
    expect(requests[1].body).toBeUndefined();
  });

  it("a body-bearing action keeps the options' own toJSON() and the path value read once", async () => {
    const requests: Array<{ url: string; method?: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: init?.body,
      });
      return Response.json({ result: 'ok' });
    });
    const art = createClient('/api/v1').artcollections as unknown as {
      describe(id: string, options?: unknown): Promise<unknown>;
    };
    class DescribeOptions {
      tone = 'warm';
      backing = 'not for the wire';
      toJSON() {
        return { tone: this.tone, mood: `${this.tone}-derived` };
      }
    }

    await art.describe('1', new DescribeOptions());

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/v1/artcollections/1/descriptions/warm');
    expect(requests[0].method).not.toBe('GET');
    expect(JSON.parse(String(requests[0].body))).toEqual({
      tone: 'warm',
      mood: 'warm-derived',
    });
  });

  it('a GET custom action keeps String() for array members and JSON for objects', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const collectionClient =
      client.genClientProductCollection as typeof client.genClientProductCollection & {
        findFeatured(options?: Record<string, unknown>): Promise<unknown>;
      };

    await collectionClient.findFeatured({
      tags: [1, 'two', { a: 1 }, [3, 4], null],
      filter: { a: [1, 2] },
      flag: false,
    });

    expect([
      ...new URL(urls[0], 'http://local').searchParams.entries(),
    ]).toEqual([
      ['tags', '1'],
      ['tags', 'two'],
      ['tags', '[object Object]'],
      ['tags', '3,4'],
      ['tags', 'null'],
      ['filter', '{"a":[1,2]}'],
      ['flag', 'false'],
    ]);
  });

  it('a GET custom action sends a Date option as its ISO string', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const collectionClient =
      client.genClientProductCollection as typeof client.genClientProductCollection & {
        findFeatured(options?: Record<string, unknown>): Promise<unknown>;
      };

    await collectionClient.findFeatured({
      since: new Date('2026-03-04T05:06:07.890Z'),
    });

    expect(new URL(urls[0], 'http://local').searchParams.get('since')).toBe(
      '2026-03-04T05:06:07.890Z',
    );
  });

  /** A generated-client fetcher call that must reject before any request. */
  async function expectListRejected(
    params: unknown,
    message: RegExp,
  ): Promise<void> {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = client.genclientproducts.list(params);
    }).not.toThrow();
    await expect(pending).rejects.toThrow(message);
    expect(urls).toEqual([]);
  }

  it('list() sends an [in] list and an orderBy list as one comma-joined value each', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');
    const releasedAt = new Date('2026-03-04T05:06:07.890Z');

    await client.genclientproducts.list({
      'id[in]': ['a', 'b'],
      orderBy: ['price DESC', 'name ASC'],
      'releasedAt[gte]': releasedAt,
      featured: false,
    });

    expect(urls).toHaveLength(1);
    const params = new URL(urls[0], 'http://local').searchParams;
    expect([...params.entries()]).toEqual([
      ['id[in]', 'a,b'],
      ['orderBy', 'price DESC,name ASC'],
      ['releasedAt[gte]', '2026-03-04T05:06:07.890Z'],
      ['featured', 'false'],
    ]);
  });

  it('list() flattens a structured where into field parameters', async () => {
    const urls = recordRequestedUrls();
    const client = createClient('/api/v1');

    await client.genclientproducts.list({
      where: {
        name: 'Widget',
        'price >=': 3,
        id: { op: 'in', value: ['a', 'b'] },
        featured: { op: '=', value: true },
      },
      limit: 5,
    });

    const params = new URL(urls[0], 'http://local').searchParams;
    expect([...params.entries()]).toEqual([
      ['name', 'Widget'],
      ['price[gte]', '3'],
      ['id[in]', 'a,b'],
      ['featured', 'true'],
      ['limit', '5'],
    ]);
  });

  it.each([
    [{ 'id[in]': [] }, /empty list would match every row/],
    [{ orderBy: [] }, /empty list would match every row/],
    [{ where: { id: { op: 'in', value: [] } } }, /empty list/],
    [{ name: null }, /null has no list query form/],
    [{ where: { name: null } }, /null has no list query form/],
    [{ name: ['a', 'b'] }, /a list needs the \[in\] operator/],
    [{ 'name[in]': ['a,b', 'c'] }, /cannot contain a comma/],
    [{ name: { nested: true } }, /expected a string, number, boolean or Date/],
    [{ releasedAt: new Date('not a date') }, /invalid Date/],
    [{ price: Number.NaN }, /not a finite number/],
    [{ name: 'a', where: { name: 'b' } }, /given more than once/],
    [{ where: { 'name not like': 'a%' } }, /unsupported operator/],
    [{ 'name[eq]': 'a' }, /unsupported operator/],
    [{ where: { limit: 1 } }, /not a filterable field name/],
    [{ where: [{ name: 'a' }] }, /expected an object of conditions/],
    ['name=a', /expected a plain object/],
    [new Map([['name', 'a']]), /expected a plain object/],
    [new URLSearchParams('name=a'), /expected a plain object/],
    [new Date(0), /expected a plain object/],
    [{ where: new Map([['name', 'a']]) }, /expected an object of conditions/],
    [
      { where: new URLSearchParams('name=a') },
      /expected an object of conditions/,
    ],
    [{ 'name[in]': 'a,b' }, /must be a non-empty list/],
    [
      { where: { name: { op: 'in', value: 'Smith, Jr.' } } },
      /must be a non-empty list/,
    ],
    [{ where: { 'name in': 'a' } }, /must be a non-empty list/],
    [null, /expected a plain object/],
    [{ where: { price: { op: null, value: 10 } } }, /unsupported operator/],
    [{ where: { price: { op: false, value: 10 } } }, /unsupported operator/],
    [{ where: { price: { op: '', value: 10 } } }, /unsupported operator/],
    [{ name: 'a\uD800' }, /not a well-formed string/],
    [{ 'name[in]': ['a', '\uDC00b'] }, /not a well-formed string/],
    [{ 'na\uD800me': 'a' }, /not a well-formed string/],
    [{ orderBy: ['name\uD800 ASC'] }, /not a well-formed string/],
  ])('list(%o) rejects before sending a request', async (params, message) => {
    await expectListRejected(params, message);
  });

  it('list() [in], orderBy, boolean and datetime filters return every matching row from the REST route', async () => {
    const early = new Date('2026-01-01T00:00:00.000Z');
    const late = new Date('2026-06-01T00:00:00.000Z');
    const seeds = [
      { name: 'Grammar A', price: 40, featured: true, releasedAt: early },
      { name: 'Grammar B', price: 40, featured: false, releasedAt: late },
      { name: 'Grammar C', price: 41, featured: true, releasedAt: late },
      { name: 'Grammar D', price: 42, featured: false, releasedAt: null },
    ];
    for (const seed of seeds) {
      const row = await collection.create(seed);
      await row.save();
    }
    stubFetchToServer(handler);
    const client = createClient('/api/v1');
    const names = (rows: unknown) =>
      (rows as Array<Record<string, unknown>>).map((row) => row.name);

    expect(
      names(
        await client.genclientproducts.list({
          'name[in]': ['Grammar A', 'Grammar B', 'Grammar C'],
          orderBy: ['price DESC', 'name DESC'],
        }),
      ),
    ).toEqual(['Grammar C', 'Grammar B', 'Grammar A']);
    expect(
      names(
        await client.genclientproducts.list({
          where: { name: { op: 'in', value: ['Grammar A', 'Grammar D'] } },
          orderBy: 'name ASC',
        }),
      ),
    ).toEqual(['Grammar A', 'Grammar D']);
    expect(
      names(
        await client.genclientproducts.list({
          'name[like]': 'Grammar %',
          featured: true,
          orderBy: 'name ASC',
        }),
      ),
    ).toEqual(['Grammar A', 'Grammar C']);
    expect(
      names(
        await client.genclientproducts.list({
          where: { 'name like': 'Grammar %', featured: false },
          orderBy: 'name ASC',
        }),
      ),
    ).toEqual(['Grammar B', 'Grammar D']);
    expect(
      names(
        await client.genclientproducts.list({
          'name[like]': 'Grammar %',
          'releasedAt[gte]': late,
          orderBy: 'name ASC',
        }),
      ),
    ).toEqual(['Grammar B', 'Grammar C']);
    expect(
      names(
        await client.genclientproducts.list({
          'name[like]': 'Grammar %',
          releasedAt: early,
        }),
      ),
    ).toEqual(['Grammar A']);
  });

  it('the REST list and count routes refuse a repeated query parameter and keep comma-delimited [in]', async () => {
    for (const name of ['Repeat A', 'Repeat B']) {
      const row = await collection.create({ name, price: 50 });
      await row.save();
    }
    for (const path of ['genclientproducts', 'genclientproducts/count']) {
      const repeated = await handler(
        new Request(
          `http://local/api/v1/${path}?name%5Bin%5D=Repeat%20A&name%5Bin%5D=Repeat%20B`,
        ),
      );
      expect(repeated.status).toBe(400);
      expect(JSON.stringify(await repeated.json())).toContain(
        'REPEATED_QUERY_PARAMETER',
      );
    }
    const repeatedLimit = await handler(
      new Request('http://local/api/v1/genclientproducts?limit=1&limit=2'),
    );
    expect(repeatedLimit.status).toBe(400);

    const joined = await handler(
      new Request(
        'http://local/api/v1/genclientproducts?name%5Bin%5D=Repeat%20A,Repeat%20B&orderBy=name%20ASC',
      ),
    );
    expect(joined.status).toBe(200);
    expect(
      ((await joined.json()) as Array<Record<string, unknown>>).map(
        (row) => row.name,
      ),
    ).toEqual(['Repeat A', 'Repeat B']);
    const count = await handler(
      new Request(
        'http://local/api/v1/genclientproducts/count?name%5Bin%5D=Repeat%20A,Repeat%20B',
      ),
    );
    expect(await count.json()).toEqual({ count: 2 });
  });

  it('list() with a key that is not a field rejects with 400 QUERY_FIELD_NOT_ALLOWED', async () => {
    stubFetchToServer(handler);
    const client = createClient('/api/v1');

    await expect(
      client.genclientproducts.list({ cache: false }),
    ).rejects.toMatchObject({
      name: 'SmrtClientError',
      status: 400,
      code: 'QUERY_FIELD_NOT_ALLOWED',
    });
  });

  it.each([
    ['price%5Bgte%5D=100&price%20%3E%3D=10'],
    ['price%20%3E%3D=10&price%5Bgte%5D=100'],
  ])('the REST list and count routes refuse two spellings of one predicate (?%s)', async (query) => {
    for (const path of ['genclientproducts', 'genclientproducts/count']) {
      const response = await handler(
        new Request(`http://local/api/v1/${path}?${query}`),
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(
        'REPEATED_QUERY_PARAMETER',
      );
    }
  });

  it('a boolean column compared with like keeps its string pattern in both spellings', async () => {
    for (const query of ['featured like=1', 'featured[like]=1']) {
      expect(
        parseRestListWhere(new URLSearchParams(query), 'GenClientProduct'),
      ).toEqual({ 'featured like': '1' });
    }
    // Equality on the same column still decodes.
    expect(
      parseRestListWhere(new URLSearchParams('featured=1'), 'GenClientProduct'),
    ).toEqual({ featured: true });
    for (const query of ['featured%20like=1', 'featured%5Blike%5D=1']) {
      for (const path of ['genclientproducts', 'genclientproducts/count']) {
        const response = await handler(
          new Request(`http://local/api/v1/${path}?${query}`),
        );
        expect(response.status).toBe(200);
      }
    }
  });

  it('the REST list and count routes refuse a __proto__ filter key as a field', async () => {
    for (const path of ['genclientproducts', 'genclientproducts/count']) {
      const response = await handler(
        new Request(`http://local/api/v1/${path}?__proto__=x`),
      );
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(
        'QUERY_FIELD_NOT_ALLOWED',
      );
    }
    stubFetchToServer(handler);
    await expect(
      createClient('/api/v1').genclientproducts.list(
        JSON.parse('{"__proto__":"x"}'),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'QUERY_FIELD_NOT_ALLOWED' });
  });

  it.each([
    // An instant with Z or an offset becomes UTC, keeping every digit.
    ['2026-03-04T05:06:07Z', '2026-03-04T05:06:07.000Z'],
    ['2026-03-04T05:06:07.5Z', '2026-03-04T05:06:07.500Z'],
    ['2026-03-04T05:06:07.123456Z', '2026-03-04T05:06:07.123456Z'],
    ['2026-03-04T07:06:07.123456+02:00', '2026-03-04T05:06:07.123456Z'],
    ['2026-03-04T00:30:00-0130', '2026-03-04T02:00:00.000Z'],
    ['2026-03-04T05:06Z', '2026-03-04T05:06:00.000Z'],
    // A date alone is UTC midnight.
    ['2026-03-04', '2026-03-04T00:00:00.000Z'],
    // Anything else passes through as sent: no server-zone reading.
    ['2026-03-04T05:06:07', '2026-03-04T05:06:07'],
    ['2026-03-04 05:06:07Z', '2026-03-04 05:06:07Z'],
    ['1', '1'],
    ['2026-02-30T00:00:00Z', '2026-02-30T00:00:00Z'],
    ['2026-03-04T05:06:07+25:00', '2026-03-04T05:06:07+25:00'],
  ])('a datetime filter value %s is read as %s', (sent, read) => {
    const where = parseRestListWhere(
      new URLSearchParams({ releasedAt: sent, 'created_at[gte]': sent }),
      'GenClientProduct',
    );
    expect(where.releasedAt).toBe(read);
    expect(where['created_at >=']).toBe(read);
  });

  it('a datetime filter keeps microseconds on PostgreSQL (PGlite)', async () => {
    const pg = await getTestDatabase({
      type: 'pglite',
      url: ':memory:',
      classes: ['GenClientProduct'],
    });
    try {
      const products = await GenClientProductCollection.create({ db: pg });
      const row = await products.create({ name: 'Micro', price: 1 });
      await row.save();
      await pg.query(
        `UPDATE ${products.tableName} SET released_at = '2026-03-04T05:06:07.123456Z'`,
      );
      const pgHandler = new APIGenerator(
        { basePath: '/api/v1' },
        { db: pg },
      ).generateHandler();
      const names = async (query: string) => {
        const response = await pgHandler(
          new Request(`http://local/api/v1/genclientproducts?${query}`),
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as Array<{ name: string }>).map(
          (item) => item.name,
        );
      };
      const enc = encodeURIComponent;

      expect(
        await names(`releasedAt=${enc('2026-03-04T05:06:07.123456Z')}`),
      ).toEqual(['Micro']);
      expect(
        await names(`releasedAt=${enc('2026-03-04T07:06:07.123456+02:00')}`),
      ).toEqual(['Micro']);
      expect(
        await names(`releasedAt=${enc('2026-03-04T05:06:07.123Z')}`),
      ).toEqual([]);
      expect(
        await names(
          `releasedAt%5Bgte%5D=${enc('2026-03-04T05:06:07.123457Z')}`,
        ),
      ).toEqual([]);
      expect(
        await names(`releasedAt%5Bgt%5D=${enc('2026-03-04T05:06:07.123455Z')}`),
      ).toEqual(['Micro']);
      expect(
        await names(
          `releasedAt%5Blte%5D=${enc('2026-03-04T05:06:07.123456Z')}`,
        ),
      ).toEqual(['Micro']);
    } finally {
      await pg.close?.();
    }
  });

  describe('a column declared with different types across a family is not decoded', () => {
    function declareFamily(order: 'text-first' | 'boolean-first') {
      @smrt({ tableStrategy: 'sti' })
      class FlagFamilyBase extends SmrtObject {
        @field({ type: 'boolean' })
        settled: boolean = false;
      }
      const declareText = () => {
        class FlagTextMember extends FlagFamilyBase {
          @field({ type: 'text' })
          flag: string = '';
        }
        smrt()(FlagTextMember);
      };
      const declareBoolean = () => {
        class FlagBooleanMember extends FlagFamilyBase {
          @field({ type: 'boolean' })
          flag: boolean = false;
        }
        smrt()(FlagBooleanMember);
      };
      if (order === 'text-first') {
        declareText();
        declareBoolean();
      } else {
        declareBoolean();
        declareText();
      }
    }

    it.each([
      'text-first',
      'boolean-first',
    ] as const)('in registration order %s', (order) => {
      const restore = snapshotObjectRegistryState();
      try {
        declareFamily(order);
        for (const model of [
          'FlagFamilyBase',
          'FlagTextMember',
          'FlagBooleanMember',
        ]) {
          const where = parseRestListWhere(
            new URLSearchParams('flag=true&settled=true'),
            model,
          );
          // The disputed column passes through; the agreed one decodes.
          expect(where.flag).toBe('true');
          expect(where.settled).toBe(true);
        }
      } finally {
        restore();
      }
    });
  });
});
