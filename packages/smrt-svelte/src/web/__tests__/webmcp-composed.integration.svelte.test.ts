/**
 * Mounted UI half of the application composition fixture (#2523).
 *
 * A real Provider owns a Form and DataTable at once. This catches lifecycle
 * mistakes that isolated registry tests miss: controls must be discoverable,
 * the DataSurface must be present, and an agent stage request must not apply a
 * value without a human gesture.
 */

import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type { WebMcpToolDefinition } from '@happyvertical/smrt-web';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fixture from './webmcp-composed.fixture.svelte';
import SsrFixture from './webmcp-ssr.fixture.svelte';

type CapturedTool = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
  signal?: AbortSignal;
};

afterEach(() => {
  delete document.modelContext;
});

describe('composed Provider WebMCP surface (#2523)', () => {
  const generatedReadDefinition: WebMcpToolDefinition = {
    collection: 'fixture-items',
    objectRef: '@fixture/app:FixtureItem',
    className: 'FixtureItem',
    endpoint: '/fixture-items',
    idField: 'id',
    idType: 'text',
    relationships: [],
    action: 'get',
    name: 'fixture_generated_read',
    description: 'Read one fixture item.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    readOnly: true,
    effect: 'read',
    idempotent: true,
    openWorld: false,
    route: { method: 'GET', scope: 'item', path: [] },
  };

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
    const view = render(Fixture, {
      props: {
        dataSurfaceRegistry,
        generatedDefinitions: [generatedReadDefinition],
      },
    });
    await tick();
    await tick();
    await vi.waitFor(() =>
      expect(registered.map((tool) => tool.name)).toContain(
        'fixture_generated_read',
      ),
    );

    expect(registered.map((tool) => tool.name)).toEqual([
      'smrt_ui_list_form_controls',
      'smrt_ui_inspect_form_control',
      'smrt_ui_execute_form_control',
      'smrt_ui_list_data_surfaces',
      'smrt_ui_inspect_data_surface',
      'smrt_ui_execute_data_surface_control',
      'fixture_component_preview',
      'fixture_generated_read',
    ]);
    expect(dataSurfaceRegistry.list()).toHaveLength(1);

    const listControls = registered[0];
    if (!listControls)
      throw new Error('list form-controls tool was not registered');
    expect(JSON.parse(await listControls.execute({}))).toMatchObject({
      ok: true,
      result: [{ identity: { formId: 'fixture-form', controlId: 'title' } }],
    });
    const executeForm = registered[2];
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

    const applied = JSON.parse(
      await executeForm.execute({
        action: 'apply',
        identity: { formId: 'fixture-form', controlId: 'title' },
      }),
    );
    expect(applied).toMatchObject({
      result: { ok: false, reason: 'human_confirmation_required' },
    });

    const bespoke = registered[6];
    if (!bespoke) throw new Error('bespoke component tool was not registered');
    expect(JSON.parse(await bespoke.execute({}))).toEqual({
      ok: true,
      source: 'bespoke-component',
    });

    view.unmount();
    expect(dataSurfaceRegistry.list()).toEqual([]);
    expect(registered.every((tool) => tool.signal?.aborted)).toBe(true);
  });
});
