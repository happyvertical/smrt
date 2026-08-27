/**
 * WebMCP composition fixture (#2523).
 *
 * This is deliberately an application-shaped test rather than a scripted
 * fetcher test: SMRT objects use a real in-memory SQLite database and all
 * browser calls go through a real APIGenerator REST handler. The only doubles
 * are the browser's modelContext registry and the authenticated fetch bridge.
 * The latter is a same-process transport adapter around the generated handler,
 * so auth, action exposure, serialization, and persistence still execute.
 */

import {
  APIGenerator,
  field,
  foreignKey,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createDefinitionFetchers,
  createSmrtCollection,
  createSmrtWebClient,
  type SmrtCrudFetchers,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  type WebMcpToolDefinition,
  type WebToolDescriptor,
} from './index.js';
import { registerWebMcpTools } from './webmcp.js';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
})
class WebMcpFixtureLabel extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: { name?: string } = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class WebMcpFixtureLabelCollection extends SmrtCollection<WebMcpFixtureLabel> {
  static readonly _itemClass = WebMcpFixtureLabel;
}

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
})
class WebMcpFixtureItem extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @foreignKey(WebMcpFixtureLabel, { nullable: true })
  labelId: string | null = null;

  @field({ type: 'text', sensitive: true })
  secret = '';

  constructor(options: { name?: string; labelId?: string | null } = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.labelId !== undefined) this.labelId = options.labelId;
  }
}

class WebMcpFixtureItemCollection extends SmrtCollection<WebMcpFixtureItem> {
  static readonly _itemClass = WebMcpFixtureItem;
}

@smrt({
  api: {
    include: ['get'],
  },
})
class WebMcpFixtureGetOnly extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: { name?: string } = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class WebMcpFixtureGetOnlyCollection extends SmrtCollection<WebMcpFixtureGetOnly> {
  static readonly _itemClass = WebMcpFixtureGetOnly;
}

@smrt({
  api: {
    include: ['run'],
    routes: { run: { method: 'POST', scope: 'collection', path: 'run' } },
  },
})
class WebMcpFixtureCommand extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: { name?: string } = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class WebMcpFixtureCommandCollection extends SmrtCollection<WebMcpFixtureCommand> {
  static readonly _itemClass = WebMcpFixtureCommand;

  /** Collection-scoped custom action; no list route is required to invoke it. */
  async run(options: { value?: string } = {}) {
    return { accepted: options.value ?? 'default' };
  }
}

ObjectRegistry.registerCollection(
  'WebMcpFixtureLabel',
  WebMcpFixtureLabelCollection,
);
ObjectRegistry.registerCollection(
  'WebMcpFixtureItem',
  WebMcpFixtureItemCollection,
);
ObjectRegistry.registerCollection(
  'WebMcpFixtureGetOnly',
  WebMcpFixtureGetOnlyCollection,
);
ObjectRegistry.registerCollection(
  'WebMcpFixtureCommand',
  WebMcpFixtureCommandCollection,
);

type CapturedTool = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
  signal?: AbortSignal;
};

const itemDefinition: SmrtWebCollectionDefinition = {
  name: 'webmcpfixtureitems',
  objectRef: '@fixture/smrt-web:WebMcpFixtureItem',
  className: 'WebMcpFixtureItem',
  endpoint: '/webmcpfixtureitems',
  idField: 'id',
  actions: ['list', 'get', 'create', 'update', 'delete'],
  fields: {
    name: { type: 'text', required: true },
    labelId: { type: 'foreignKey' },
    secret: { type: 'text', sensitive: true },
  },
  relationships: [
    {
      field: 'labelId',
      kind: 'foreignKey',
      relatedCollection: 'webmcpfixturelabels',
    },
  ],
  toolDescriptors: [
    {
      action: 'list',
      name: 'webmcpfixtureitem_list',
      description: 'List fixture items',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
    },
    {
      action: 'create',
      name: 'webmcpfixtureitem_create',
      description: 'Create a fixture item',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      readOnly: false,
    },
  ] satisfies WebToolDescriptor[],
};

const labelDefinition: SmrtWebCollectionDefinition = {
  name: 'webmcpfixturelabels',
  objectRef: '@fixture/smrt-web:WebMcpFixtureLabel',
  className: 'WebMcpFixtureLabel',
  endpoint: '/webmcpfixturelabels',
  idField: 'id',
  actions: ['list', 'get', 'create', 'update', 'delete'],
  fields: { name: { type: 'text', required: true } },
  relationships: [],
};

function canonicalDefinition(
  overrides: Partial<WebMcpToolDefinition> = {},
): WebMcpToolDefinition {
  return {
    collection: 'webmcpfixturegetonlys',
    objectRef: '@fixture/smrt-web:WebMcpFixtureGetOnly',
    className: 'WebMcpFixtureGetOnly',
    endpoint: '/webmcpfixturegetonlys',
    idField: 'id',
    idType: 'uuid',
    relationships: [],
    action: 'get',
    name: 'webmcpfixturegetonly_get',
    description: 'Get one fixture record',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    readOnly: true,
    effect: 'read',
    idempotent: true,
    openWorld: false,
    route: { method: 'GET', scope: 'item', path: [] },
    ...overrides,
  };
}

const commandDefinition = canonicalDefinition({
  collection: 'webmcpfixturecommands',
  objectRef: '@fixture/smrt-web:WebMcpFixtureCommand',
  className: 'WebMcpFixtureCommand',
  endpoint: '/webmcpfixturecommands',
  action: 'run',
  name: 'webmcpfixturecommand_run',
  description: 'Run the fixture command',
  inputSchema: {
    type: 'object',
    properties: { options: { type: 'object' } },
  },
  readOnly: false,
  effect: 'write',
  idempotent: true,
  openWorld: false,
  route: {
    method: 'POST',
    scope: 'collection',
    path: ['run'],
    optionsBag: true,
  },
});

describe('WebMCP application composition (#2523)', () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let handler: (request: Request) => Promise<Response>;
  let itemCollection: WebMcpFixtureItemCollection;
  let getOnly: WebMcpFixtureGetOnlyCollection;
  let command: WebMcpFixtureCommandCollection;
  const baseUrl = 'http://fixture.local/api/v1';

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'WebMcpFixtureLabel',
        'WebMcpFixtureItem',
        'WebMcpFixtureGetOnly',
        'WebMcpFixtureCommand',
      ],
    });
    const labels = await WebMcpFixtureLabelCollection.create({ db });
    const label = await labels.create({ name: 'primary' });
    itemCollection = await WebMcpFixtureItemCollection.create({ db });
    await itemCollection.create({ name: 'first', labelId: label.id });
    getOnly = await WebMcpFixtureGetOnlyCollection.create({ db });
    const record = await getOnly.create({ name: 'read me' });
    command = await WebMcpFixtureCommandCollection.create({ db });
    await command.create({ name: 'command' });

    const api = new APIGenerator(
      {
        basePath: '/api/v1',
        authMiddleware: () => async (request) => {
          const authorization = request.headers.get('authorization');
          if (!authorization)
            return new Response('auth required', { status: 401 });
          if (authorization !== 'Bearer fixture-user') {
            return new Response('forbidden', { status: 403 });
          }
          return request;
        },
      },
      { db },
    );
    api.registerCollection('webmcpfixtureitems', itemCollection);
    api.registerCollection('webmcpfixturelabels', labels);
    api.registerCollection('webmcpfixturegetonlys', getOnly);
    api.registerCollection('webmcpfixturecommands', command);
    handler = api.generateHandler();

    // Assert the canonical test identifier is reachable without materializing
    // the collection in the browser. The record remains local to this setup.
    expect(record.id).toEqual(expect.any(String));
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  afterAll(async () => {
    await db?.close?.();
  });

  function authenticatedFetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input), `${baseUrl}/`);
      const headers = new Headers(init?.headers);
      headers.set('authorization', 'Bearer fixture-user');
      return handler(
        new Request(requestUrl, {
          ...init,
          headers,
        }),
      );
    }) as typeof fetch;
  }

  function installModelContext(): { tools: CapturedTool[] } {
    const tools: CapturedTool[] = [];
    (globalThis as { document?: unknown }).document = {
      modelContext: {
        registerTool(tool: CapturedTool, options?: { signal?: AbortSignal }) {
          tool.signal = options?.signal;
          tools.push(tool);
        },
      },
    };
    return { tools };
  }

  it('keeps REST auth fail-closed for browser tool calls', async () => {
    const unauthenticated = await handler(
      new Request(`${baseUrl}/webmcpfixtureitems`),
    );
    expect(unauthenticated.status).toBe(401);

    const unauthorized = await handler(
      new Request(`${baseUrl}/webmcpfixtureitems`, {
        headers: { authorization: 'Bearer another-user' },
      }),
    );
    expect(unauthorized.status).toBe(403);
    // Principal-bound server tools are not part of this browser registrar.
    expect(
      itemDefinition.toolDescriptors?.map((tool) => tool.name),
    ).not.toContain('principal_read');
  });

  it('executes generated list/create, get-only, and custom-action-only tools', async () => {
    const { tools } = installModelContext();
    const client = createSmrtWebClient();
    const itemFetchers = createDefinitionFetchers(
      itemDefinition,
      '/api/v1',
      authenticatedFetch(),
    );
    const getOnlyRecord = (await getOnly.list())[0];
    const getDefinition = canonicalDefinition();
    const registration = registerWebMcpTools(
      [itemDefinition, getDefinition, commandDefinition],
      {
        effects: ['read', 'write'],
        client,
        resolveFetchers: () => itemFetchers,
        resolveToolFetchers: (definition) =>
          createDefinitionFetchers(definition, '/api/v1', authenticatedFetch()),
      },
    );
    await registration.ready;

    expect(tools.map((tool) => tool.name)).toEqual([
      'webmcpfixtureitem_list',
      'webmcpfixtureitem_create',
      'webmcpfixturegetonly_get',
      'webmcpfixturecommand_run',
    ]);
    const list = tools.find((tool) => tool.name.endsWith('_list'));
    const create = tools.find((tool) => tool.name.endsWith('_create'));
    const get = tools.find((tool) => tool.name.endsWith('_get'));
    const run = tools.find((tool) => tool.name.endsWith('_run'));
    if (!list || !create || !get || !run) {
      throw new Error('fixture generated tools were not all registered');
    }
    expect(JSON.parse(await list.execute({}))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'first' })]),
    );
    expect(JSON.parse(await create.execute({ name: 'agent-created' }))).toEqual(
      expect.objectContaining({ name: 'agent-created' }),
    );
    expect(
      JSON.parse(await get.execute({ id: getOnlyRecord?.id })),
    ).toMatchObject({
      name: 'read me',
    });
    expect(
      JSON.parse(await run.execute({ options: { value: 'ok' } })),
    ).toMatchObject({
      result: { accepted: 'ok' },
    });

    registration();
    expect(tools.every((tool) => tool.signal?.aborted)).toBe(true);
  });

  it('defaults to read exposure and namespaces the selected browser surface', async () => {
    const { tools } = installModelContext();
    const registration = registerWebMcpTools(
      [itemDefinition, commandDefinition],
      {
        namespace: 'fixture',
        client: createSmrtWebClient(),
        resolveFetchers: () =>
          createDefinitionFetchers(
            itemDefinition,
            '/api/v1',
            authenticatedFetch(),
          ),
        resolveToolFetchers: (definition) =>
          createDefinitionFetchers(definition, '/api/v1', authenticatedFetch()),
      },
    );
    await registration.ready;

    expect(tools.map((tool) => tool.name)).toEqual([
      'fixture_webmcpfixtureitem_list',
    ]);
    registration();
    expect(tools.every((tool) => tool.signal?.aborted)).toBe(true);
  });

  it('invalidates a related mounted collection after an agent mutation', async () => {
    const { tools } = installModelContext();
    const client = createSmrtWebClient();
    let labelLists = 0;
    const labelFetchers: SmrtCrudFetchers = {
      ...createDefinitionFetchers(
        labelDefinition,
        '/api/v1',
        authenticatedFetch(),
      ),
      list: async (params) => {
        labelLists += 1;
        return createDefinitionFetchers(
          labelDefinition,
          '/api/v1',
          authenticatedFetch(),
        ).list(params);
      },
    };
    const labels = createSmrtCollection(labelDefinition, {
      client,
      fetchers: labelFetchers,
      staleTimeMs: 60_000,
    });
    const subscription = labels.subscribeChanges(() => {});
    await labels.preload();
    expect(labelLists).toBe(1);

    const registration = registerWebMcpTools([itemDefinition], {
      effects: ['write'],
      client,
      resolveFetchers: () =>
        createDefinitionFetchers(
          itemDefinition,
          '/api/v1',
          authenticatedFetch(),
        ),
    });
    await registration.ready;
    const create = tools.find((tool) => tool.name.endsWith('_create'));
    if (!create) throw new Error('fixture create tool was not registered');
    await create.execute({ name: 'relationship-refresh' });

    for (let attempt = 0; attempt < 50 && labelLists < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(labelLists).toBeGreaterThanOrEqual(2);

    registration();
    subscription.unsubscribe();
    await labels.cleanup();
  });
});
