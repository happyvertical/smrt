/**
 * Mounted UI half of the application composition fixture (#2523).
 *
 * A real Provider owns a Form and DataTable at once. This catches lifecycle
 * mistakes that isolated registry tests miss: controls must be discoverable,
 * the DataSurface must be present, and an agent stage request must not apply a
 * value without a human gesture.
 */

import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Fixture from './webmcp-composed.fixture.svelte';

type CapturedTool = {
  name: string;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
  signal?: AbortSignal;
};

afterEach(() => {
  delete document.modelContext;
});

describe('composed Provider WebMCP surface (#2523)', () => {
  it('keeps the composed UI render safe without browser modelContext support', async () => {
    const dataSurfaceRegistry = createDataSurfaceRegistry();
    const view = render(Fixture, { props: { dataSurfaceRegistry } });
    await tick();

    expect(dataSurfaceRegistry.list()).toHaveLength(1);
    view.unmount();
    expect(dataSurfaceRegistry.list()).toEqual([]);
  });

  it('registers the mounted Form and DataTable together and preserves consent', async () => {
    const registered: CapturedTool[] = [];
    document.modelContext = {
      async registerTool(tool, options) {
        registered.push({ ...tool, signal: options?.signal });
      },
    };
    const dataSurfaceRegistry = createDataSurfaceRegistry();
    const view = render(Fixture, { props: { dataSurfaceRegistry } });
    await tick();
    await tick();

    expect(registered.map((tool) => tool.name)).toEqual([
      'smrt_ui_list_form_controls',
      'smrt_ui_inspect_form_control',
      'smrt_ui_execute_form_control',
      'smrt_ui_list_data_surfaces',
      'smrt_ui_inspect_data_surface',
      'smrt_ui_execute_data_surface_control',
      'fixture_component_preview',
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
      result: { ok: false, reason: 'consent_required' },
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
