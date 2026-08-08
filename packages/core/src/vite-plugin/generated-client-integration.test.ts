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
import { ObjectRegistry, smrt } from '../registry';
import type { SmartObjectManifest } from '../scanner/types.js';
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
    routes: { describe: { path: 'descriptions/[tone]' } },
  },
})
export class ArtCollection extends SmrtObject {
  async describe(tone: string): Promise<string> {
    void tone;
    return 'item model, not SmrtCollection';
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
    const clientSource = (await load('\0smrt:client')) as string;
    // The client key is the manifest `collection` segment. `GenClientProduct`
    // pluralizes to `genclientproducts`; assert that here so a future
    // inflection change surfaces as a readable failure rather than an
    // `undefined.list()` TypeError below.
    expect(clientSource).toContain('"genclientproducts":');
    expect(clientSource).toContain('"genClientProductCollection":');
    expect(clientSource.match(/\n {2}"genclientproducts":/g)).toHaveLength(1);
    expect(clientSource.match(/\n {2}"contents":/g)).toHaveLength(1);
    expect(clientSource).toContain('"contents2":');
    expect(clientSource).toContain('findFeatured: (options)');
    expect(clientSource).not.toContain('findFeatured: (id, options)');
    expect(clientSource).not.toContain('list: (id, options)');
    expect(clientSource).toContain('invalidItemScope: (options)');
    expect(clientSource).not.toContain('invalidItemScope: (id, options)');
    expect(clientSource).toContain('invalidCollectionScope: (id, options)');
    expect(clientSource).not.toContain('invalidCollectionScope: (options)');
    expect(clientSource).toContain('describe: (id, options)');
    expect(clientSource).not.toContain('describe: (options)');
    expect(clientSource).toContain('featured: (options)');
    expect(clientSource).toContain('summarize: (id, options)');
    expect(clientSource).toContain('findUnread: (options)');
    expect(clientSource).not.toContain('findUnread: (id, options)');
    const customOnlyClientSource = clientSource.match(
      /\n {2}"genclientsecrets": \{([\s\S]*?)\n {2}\}/,
    )?.[1];
    expect(customOnlyClientSource).toContain('reveal: (options)');
    expect(customOnlyClientSource).not.toMatch(
      /\b(list|get|create|update|delete|search):/,
    );
    const partialClientSource = clientSource.match(
      /\n {2}"genclientreadonlies": \{([\s\S]*?)\n {2}\}/,
    )?.[1];
    expect(partialClientSource).toContain('get: (id)');
    expect(partialClientSource).toContain('ping: (id, options)');
    expect(partialClientSource).not.toMatch(
      /\b(list|create|update|delete|search):/,
    );
    const declarationSource = readFileSync(
      join(projectRoot, 'src', 'types', 'virtual-modules.d.ts'),
      'utf-8',
    );
    expect(declarationSource).toContain(
      '"genclientproducts": CrudOperations<GenClientProductData> & {\n      invalidCollectionScope(id: string, options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).not.toContain(
      '"genclientproducts": CrudOperations<GenClientProductCollectionData>;',
    );
    expect(declarationSource).toContain(
      '"genClientProductCollection": Pick<CrudOperations<GenClientProductData>, "list" | "get" | "create" | "update" | "delete"> & {',
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
      '"contents": CrudOperations<ContentData> & {\n      summarize(id: string, options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      '"contents2": CrudOperations<ContentData> & {\n      featured(options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      '"genClientEmailCollection": CrudOperations<GenClientMessageData> & {\n      findUnread(options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain(
      '"genclientsecrets": {\n      reveal(options?: Record<string, never>): Promise<any>;\n    };',
    );
    expect(declarationSource).not.toContain(
      '"genclientsecrets": CrudOperations<GenClientSecretData>',
    );
    expect(declarationSource).toContain(
      '"genclientreadonlies": Pick<CrudOperations<GenClientReadonlyData>, "get"> & {\n      ping(id: string, options?: Record<string, never>): Promise<any>;',
    );
    expect(declarationSource).toContain('error?: string | SmrtClientFailure;');
    expect(declarationSource).toContain('code?: string;');

    // Evaluate the generated ESM the way a bundler would: write it to disk and
    // dynamic-import it. This exercises the ACTUAL emitted source, not a
    // hand-rolled reimplementation.
    clientModuleDir = mkdtempSync(join(tmpdir(), 'smrt-gen-client-mod-'));
    const clientModulePath = join(clientModuleDir, 'client.mjs');
    writeFileSync(clientModulePath, clientSource, 'utf-8');
    const mod = await import(pathToFileURL(clientModulePath).href);
    createClient = mod.createClient;
    expect(Object.keys(createClient().genclientsecrets)).toEqual(['reveal']);

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

  it('quotes non-identifier keys in Vite client and web declarations', async () => {
    const declarationRoot = mkdtempSync(join(tmpdir(), 'smrt-vite-types-'));
    try {
      const manifest: SmartObjectManifest = {
        version: '1.0.0',
        timestamp: 1,
        objects: {
          AuditEvent: {
            className: 'AuditEvent',
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
        '"audit-events": CrudOperations<AuditEventData>;',
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
});
