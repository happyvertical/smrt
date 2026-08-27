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
import { ManifestGenerator } from '@happyvertical/smrt-core/scanner';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildWebCollectionDefinition,
  buildWebMcpToolDefinitions,
  selectWebCollectionEntries,
} from '../../../packages/core/src/vite-plugin/web-collections.js';
import {
  createDefinitionFetchers,
  createSmrtCollection,
  createSmrtWebClient,
  type SmrtCrudFetchers,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  type WebMcpToolDefinition,
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

@smrt({ api: false })
class WebMcpFixtureDisabled extends SmrtObject {
  @field({ type: 'text' })
  name = '';
}

@smrt({ api: { include: ['list', 'get'], exclude: ['list'] } })
class WebMcpFixtureExcluded extends SmrtObject {
  @field({ type: 'text' })
  name = '';
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

describe('WebMCP application composition (#2523)', () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let handler: (request: Request) => Promise<Response>;
  let itemCollection: WebMcpFixtureItemCollection;
  let getOnly: WebMcpFixtureGetOnlyCollection;
  let command: WebMcpFixtureCommandCollection;
  let itemDefinition: SmrtWebCollectionDefinition;
  let labelDefinition: SmrtWebCollectionDefinition;
  let generatedDefinitions: WebMcpToolDefinition[];
  let getDefinition: WebMcpToolDefinition;
  let commandDefinition: WebMcpToolDefinition;
  const baseUrl = 'http://fixture.local/api/v1';

  beforeAll(async () => {
    // Use the same AST manifest builder that emits the production virtual web
    // module. The fixture must exercise generated descriptors, not a copied
    // hand-authored approximation of their shape.
    const scanner = new OxcScanner({
      cwd: process.cwd(),
      include: ['src/webmcp-e2e.integration.test.ts'],
      exclude: [],
      followImports: true,
      baseClasses: ['SmrtObject', 'SmrtCollection'],
      includeStaticMethods: true,
    });
    const { results, resolved } = await scanner.scanAndResolve();
    const manifest = new ManifestAdapter().toManifest(resolved, {
      packageName: '@fixture/smrt-web',
      typeAliases: results.typeAliases,
    });
    new ManifestGenerator().applyGenerationPasses(manifest, {
      packageName: '@fixture/smrt-web',
    });
    const collectionDefinitions = selectWebCollectionEntries(manifest).map(
      (entry) => buildWebCollectionDefinition(entry, manifest),
    );
    itemDefinition = collectionDefinitions.find(
      (definition) => definition.name === 'webmcpfixtureitems',
    ) as SmrtWebCollectionDefinition;
    labelDefinition = collectionDefinitions.find(
      (definition) => definition.name === 'webmcpfixturelabels',
    ) as SmrtWebCollectionDefinition;
    generatedDefinitions = buildWebMcpToolDefinitions(manifest);
    expect(
      generatedDefinitions.some(
        (definition) => definition.className === 'WebMcpFixtureDisabled',
      ),
    ).toBe(false);
    expect(
      generatedDefinitions.some(
        (definition) =>
          definition.className === 'WebMcpFixtureExcluded' &&
          definition.action === 'list',
      ),
    ).toBe(false);
    getDefinition = generatedDefinitions.find(
      (definition) =>
        definition.action === 'get' &&
        definition.collection === 'webmcpfixturegetonlies',
    ) as WebMcpToolDefinition;
    commandDefinition = generatedDefinitions.find(
      (definition) =>
        definition.action === 'run' &&
        definition.collection === 'webmcpfixturecommands',
    ) as WebMcpToolDefinition;
    expect(itemDefinition).toBeDefined();
    expect(labelDefinition).toBeDefined();
    expect(getDefinition).toBeDefined();
    expect(commandDefinition).toBeDefined();

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
    api.registerCollection('webmcpfixturegetonlies', getOnly);
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
    return fetchWithAuthorization('Bearer fixture-user');
  }

  function fetchWithAuthorization(authorization?: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input), `${baseUrl}/`);
      const headers = new Headers(init?.headers);
      if (authorization === undefined) headers.delete('authorization');
      else headers.set('authorization', authorization);
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
    expect(generatedDefinitions.map((tool) => tool.name)).not.toContain(
      'principal_read',
    );

    const { tools } = installModelContext();
    const forbiddenRegistration = registerWebMcpTools(
      [
        generatedDefinitions.find(
          (definition) =>
            definition.collection === 'webmcpfixtureitems' &&
            definition.action === 'list',
        ) as WebMcpToolDefinition,
      ],
      {
        resolveToolFetchers: () =>
          createDefinitionFetchers(
            itemDefinition,
            '/api/v1',
            fetchWithAuthorization('Bearer another-user'),
          ),
      },
    );
    await forbiddenRegistration.ready;
    const forbiddenList = tools.find((tool) => tool.name.endsWith('_list'));
    if (!forbiddenList)
      throw new Error('fixture forbidden list tool was not registered');
    await expect(forbiddenList.execute({})).rejects.toThrow(/403/);
    forbiddenRegistration();
    tools.length = 0;

    const unauthenticatedRegistration = registerWebMcpTools(
      [
        generatedDefinitions.find(
          (definition) =>
            definition.collection === 'webmcpfixtureitems' &&
            definition.action === 'list',
        ) as WebMcpToolDefinition,
      ],
      {
        client: createSmrtWebClient(),
        resolveToolFetchers: () =>
          createDefinitionFetchers(
            itemDefinition,
            '/api/v1',
            fetchWithAuthorization(),
          ),
      },
    );
    await unauthenticatedRegistration.ready;
    const list = tools.find((tool) => tool.name.endsWith('_list'));
    if (!list) throw new Error('fixture list tool was not registered');
    await expect(list.execute({})).rejects.toThrow(/401/);
    unauthenticatedRegistration();
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
    const registration = registerWebMcpTools(
      [
        ...generatedDefinitions.filter(
          (definition) =>
            definition.collection === 'webmcpfixtureitems' &&
            ['list', 'create'].includes(definition.action),
        ),
        getDefinition,
        commandDefinition,
      ],
      {
        effects: ['read', 'write', 'destructive'],
        client,
        resolveFetchers: () => itemFetchers,
        resolveToolFetchers: (definition) =>
          createDefinitionFetchers(definition, '/api/v1', authenticatedFetch()),
      },
    );
    await registration.ready;

    expect(tools.map((tool) => tool.name)).toEqual([
      'webmcpfixtureitem_create',
      'webmcpfixtureitem_list',
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
    const listed = JSON.parse(await list.execute({})) as Array<
      Record<string, unknown>
    >;
    expect(listed).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'first' })]),
    );
    expect(listed.every((item) => !Object.hasOwn(item, 'secret'))).toBe(true);
    const created = JSON.parse(
      await create.execute({ name: 'agent-created' }),
    ) as Record<string, unknown>;
    expect(created).toEqual(expect.objectContaining({ name: 'agent-created' }));
    expect(created).not.toHaveProperty('secret');
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
      [
        ...generatedDefinitions.filter(
          (definition) => definition.collection === 'webmcpfixtureitems',
        ),
        commandDefinition,
      ],
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
      'fixture_webmcpfixtureitem_get',
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

    const itemCreateDefinition = generatedDefinitions.find(
      (definition) =>
        definition.collection === 'webmcpfixtureitems' &&
        definition.action === 'create',
    ) as WebMcpToolDefinition;
    const registration = registerWebMcpTools([itemCreateDefinition], {
      effects: ['write'],
      client,
      resolveToolFetchers: () =>
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
