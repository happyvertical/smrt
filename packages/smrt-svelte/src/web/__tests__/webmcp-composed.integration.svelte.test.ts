/**
 * Mounted UI half of the application composition fixture (#2523).
 *
 * A real Provider owns a Form and DataTable at once. This catches lifecycle
 * mistakes that isolated registry tests miss: controls must be discoverable,
 * the DataSurface must be present, and an agent stage request must not apply a
 * value without a human gesture.
 */

import {
  APIGenerator,
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { ManifestGenerator } from '@happyvertical/smrt-core/scanner';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type { WebMcpToolDefinition } from '@happyvertical/smrt-web';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { createServer } from 'vite';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { buildWebMcpToolDefinitions } from '../../../../core/src/vite-plugin/web-collections.js';
import Fixture from './webmcp-composed.fixture.svelte';
import SsrFixture from './webmcp-ssr.fixture.svelte';

type CapturedTool = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
  signal?: AbortSignal;
};

@smrt({ api: { include: ['get'] } })
class WebMcpComposedFixtureItem extends SmrtObject {
  @field({ type: 'text' })
  name = '';
}

class WebMcpComposedFixtureItemCollection extends SmrtCollection<WebMcpComposedFixtureItem> {
  static readonly _itemClass = WebMcpComposedFixtureItem;
}

ObjectRegistry.registerCollection(
  'WebMcpComposedFixtureItem',
  WebMcpComposedFixtureItemCollection,
);

afterEach(() => {
  delete document.modelContext;
});

describe('composed Provider WebMCP surface (#2523)', () => {
  let generatedReadDefinition: WebMcpToolDefinition;
  let generatedRowId = '';
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let handler: (request: Request) => Promise<Response>;
  const baseUrl = 'http://fixture.local/api/v1';

  beforeAll(async () => {
    const scanner = new OxcScanner({
      cwd: process.cwd(),
      include: ['src/web/__tests__/webmcp-composed.integration.svelte.test.ts'],
      exclude: [],
      followImports: true,
      baseClasses: ['SmrtObject', 'SmrtCollection'],
      includeStaticMethods: true,
    });
    const { results, resolved } = await scanner.scanAndResolve();
    const manifest = new ManifestAdapter().toManifest(resolved, {
      packageName: '@fixture/smrt-svelte',
      typeAliases: results.typeAliases,
    });
    new ManifestGenerator().applyGenerationPasses(manifest, {
      packageName: '@fixture/smrt-svelte',
    });
    const generated = buildWebMcpToolDefinitions(manifest).find(
      (definition) =>
        definition.className === 'WebMcpComposedFixtureItem' &&
        definition.action === 'get',
    );
    if (!generated)
      throw new Error('scanner did not emit the fixture get tool');
    generatedReadDefinition = generated;

    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['WebMcpComposedFixtureItem'],
    });
    const collection = await WebMcpComposedFixtureItemCollection.create({ db });
    const row = await collection.create({ name: 'generated read' });
    generatedRowId = row.id;
    const api = new APIGenerator(
      {
        basePath: '/api/v1',
        authMiddleware: () => async (request) => {
          if (request.headers.get('authorization') !== 'Bearer fixture-user') {
            return new Response('auth required', { status: 401 });
          }
          return request;
        },
      },
      { db },
    );
    api.registerCollection('webmcpcomposedfixtureitems', collection);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  function authenticatedFetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(input), `${baseUrl}/`);
      const headers = new Headers(init?.headers);
      headers.set('authorization', 'Bearer fixture-user');
      return handler(new Request(requestUrl, { ...init, headers }));
    }) as typeof fetch;
  }

  it('keeps the composed UI render safe without browser modelContext support', async () => {
    const dataSurfaceRegistry = createDataSurfaceRegistry();
    const view = render(Fixture, { props: { dataSurfaceRegistry } });
    await tick();

    expect(dataSurfaceRegistry.list()).toHaveLength(1);
    view.unmount();
    expect(dataSurfaceRegistry.list()).toEqual([]);
  });

  it('renders the Provider composition through the server runtime', async () => {
    const vite = await createServer({
      appType: 'custom',
      configFile: false,
      plugins: [svelte()],
      root: process.cwd(),
      server: { middlewareMode: true },
    });
    try {
      const { default: ssrFixture } = await vite.ssrLoadModule(
        '/src/web/__tests__/webmcp-ssr.fixture.svelte',
      );
      const { render: renderSsr } = await vite.ssrLoadModule('svelte/server');
      const result = renderSsr(ssrFixture);
      expect(result.body).toContain('webmcp-ssr-fixture');
    } finally {
      await vite.close();
    }
  });

  it('registers the mounted Form and DataTable together and preserves consent', async () => {
    const registered: CapturedTool[] = [];
    document.modelContext = {
      async registerTool(tool, options) {
        registered.push({ ...tool, signal: options?.signal });
      },
    };
    const dataSurfaceRegistry = createDataSurfaceRegistry();
    const fetchFn = authenticatedFetch();
    const generatedDefinitions = [generatedReadDefinition];
    const view = render(Fixture, {
      props: {
        dataSurfaceRegistry,
        generatedDefinitions,
        fetchFn,
      },
    });
    await tick();
    await tick();
    await vi.waitFor(() =>
      expect(registered.map((tool) => tool.name)).toContain(
        generatedReadDefinition.name,
      ),
    );

    expect(registered.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'smrt_ui_list_form_controls',
        'smrt_ui_inspect_form_control',
        'smrt_ui_execute_form_control',
        'smrt_ui_list_data_surfaces',
        'smrt_ui_inspect_data_surface',
        'smrt_ui_execute_data_surface_control',
        'fixture_component_preview',
        generatedReadDefinition.name,
      ]),
    );
    expect(registered).toHaveLength(8);
    expect(dataSurfaceRegistry.list()).toHaveLength(1);
    const titleInput = view.container.querySelector(
      'input[name="title"]',
    ) as HTMLInputElement | null;
    expect(titleInput?.value).toBe('');

    const listControls = registered.find(
      (tool) => tool.name === 'smrt_ui_list_form_controls',
    );
    if (!listControls)
      throw new Error('list form-controls tool was not registered');
    expect(JSON.parse(await listControls.execute({}))).toMatchObject({
      ok: true,
      result: [{ identity: { formId: 'fixture-form', controlId: 'title' } }],
    });
    const executeForm = registered.find(
      (tool) => tool.name === 'smrt_ui_execute_form_control',
    );
    if (!executeForm)
      throw new Error('execute form-control tool was not registered');
    const staged = JSON.parse(
      await executeForm.execute({
        action: 'stage',
        identity: { formId: 'fixture-form', controlId: 'title' },
        value: 'agent proposal',
      }),
    ) as { result?: { ok?: boolean; action?: string } };
    expect(staged).toMatchObject({ result: { ok: true, action: 'stage' } });
    expect(titleInput?.value).toBe('');

    const applied = JSON.parse(
      await executeForm.execute({
        action: 'apply',
        identity: { formId: 'fixture-form', controlId: 'title' },
      }),
    );
    expect(applied).toMatchObject({
      result: { ok: false, reason: 'human_confirmation_required' },
    });
    expect(titleInput?.value).toBe('');

    const generated = registered.find(
      (tool) => tool.name === generatedReadDefinition.name,
    );
    if (!generated)
      throw new Error('generated Provider tool was not registered');
    expect(
      JSON.parse(await generated.execute({ id: generatedRowId })),
    ).toMatchObject({ name: 'generated read' });

    const bespoke = registered.find(
      (tool) => tool.name === 'fixture_component_preview',
    );
    if (!bespoke) throw new Error('bespoke component tool was not registered');
    expect(JSON.parse(await bespoke.execute({}))).toEqual({
      ok: true,
      source: 'bespoke-component',
    });

    await view.rerender({
      dataSurfaceRegistry,
      generatedDefinitions,
      fetchFn,
      showChild: false,
    });
    await tick();
    await tick();
    expect(dataSurfaceRegistry.list()).toEqual([]);

    const firstRegistration = registered.slice();
    expect(
      firstRegistration
        .filter((tool) => !tool.signal?.aborted)
        .map((tool) => tool.name),
    ).toEqual([
      'smrt_ui_list_form_controls',
      'smrt_ui_inspect_form_control',
      'smrt_ui_execute_form_control',
      'smrt_ui_list_data_surfaces',
      'smrt_ui_inspect_data_surface',
      'smrt_ui_execute_data_surface_control',
      generatedReadDefinition.name,
    ]);

    await view.rerender({
      dataSurfaceRegistry,
      generatedDefinitions,
      fetchFn,
      showChild: true,
    });
    await tick();
    await tick();
    await vi.waitFor(() => expect(registered).toHaveLength(9));

    expect(dataSurfaceRegistry.list()).toHaveLength(1);
    const secondBespoke = registered.filter(
      (tool) => tool.name === 'fixture_component_preview',
    )[1];
    if (!secondBespoke)
      throw new Error('remounted bespoke tool was not registered');
    expect(secondBespoke.name).toBe('fixture_component_preview');
    expect(secondBespoke.signal?.aborted).toBe(false);
    expect(
      registered.filter((tool) => tool.name === 'fixture_component_preview'),
    ).toHaveLength(2);
    view.unmount();
    expect(registered.every((tool) => tool.signal?.aborted)).toBe(true);
  });
});
