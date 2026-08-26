import { createControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fixture from './provider-ui-registry.fixture.svelte';

afterEach(() => {
  delete document.modelContext;
});

describe('Provider WebMCP UI registry context', () => {
  it('aggregates descendant forms while preserving explicit registry overrides', async () => {
    const providerRegistry = createControlInteractionRegistry();
    const explicitRegistry = createControlInteractionRegistry();
    const signals: AbortSignal[] = [];
    const names: string[] = [];
    document.modelContext = {
      registerTool(tool, options) {
        names.push(tool.name);
        if (options?.signal) signals.push(options.signal);
      },
    };
    const view = render(Fixture, {
      props: { providerRegistry, explicitRegistry },
    });
    await tick();

    expect(names).toEqual([
      'smrt_ui_list_form_controls',
      'smrt_ui_inspect_form_control',
      'smrt_ui_execute_form_control',
      'smrt_ui_list_data_surfaces',
      'smrt_ui_inspect_data_surface',
      'smrt_ui_execute_data_surface_control',
    ]);

    expect(providerRegistry.list().map((entry) => entry.identity)).toEqual([
      { formId: 'shared-form', controlId: 'shared-name' },
      { formId: 'sibling-form', controlId: 'sibling-name' },
    ]);
    expect(explicitRegistry.list().map((entry) => entry.identity)).toEqual([
      { formId: 'explicit-form', controlId: 'explicit-name' },
    ]);

    view.unmount();
    expect(providerRegistry.list()).toEqual([]);
    expect(explicitRegistry.list()).toEqual([]);
    expect(signals).toHaveLength(6);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('keeps form interaction callbacks scoped when forms share a Provider registry', async () => {
    const providerRegistry = createControlInteractionRegistry();
    const onSharedInteraction = vi.fn();
    const onSiblingInteraction = vi.fn();
    const view = render(Fixture, {
      props: {
        providerRegistry,
        explicitRegistry: createControlInteractionRegistry(),
        onSharedInteraction,
        onSiblingInteraction,
      },
    });
    await tick();
    onSharedInteraction.mockClear();
    onSiblingInteraction.mockClear();

    await providerRegistry.execute({
      action: 'stage',
      identity: { formId: 'sibling-form', controlId: 'sibling-name' },
      value: 'private sibling value',
    });

    expect(onSharedInteraction).not.toHaveBeenCalled();
    expect(onSiblingInteraction).toHaveBeenCalled();
    expect(
      onSiblingInteraction.mock.calls.every(
        ([event]) => event.identity.formId === 'sibling-form',
      ),
    ).toBe(true);
    view.unmount();
  });

  it('moves mounted controls when the Provider registry changes', async () => {
    const firstRegistry = createControlInteractionRegistry();
    const secondRegistry = createControlInteractionRegistry();
    const explicitRegistry = createControlInteractionRegistry();
    const view = render(Fixture, {
      props: { providerRegistry: firstRegistry, explicitRegistry },
    });
    await tick();
    expect(firstRegistry.list()).toHaveLength(2);

    await view.rerender({
      providerRegistry: secondRegistry,
      explicitRegistry,
    });
    await tick();

    expect(firstRegistry.list()).toEqual([]);
    expect(secondRegistry.list()).toHaveLength(2);
    view.unmount();
  });

  it('preserves staged sibling state when another field unmounts', async () => {
    const providerRegistry = createControlInteractionRegistry();
    const explicitRegistry = createControlInteractionRegistry();
    const view = render(Fixture, {
      props: { providerRegistry, explicitRegistry },
    });
    await tick();
    await providerRegistry.execute({
      action: 'stage',
      identity: { formId: 'shared-form', controlId: 'shared-name' },
      value: 'keep staged',
    });

    await view.rerender({
      providerRegistry,
      explicitRegistry,
      showSibling: false,
    });
    await tick();

    expect(
      providerRegistry.get({
        formId: 'shared-form',
        controlId: 'shared-name',
      })?.state.stagedValue,
    ).toBe('keep staged');
    view.unmount();
  });

  it('retries a shared identity after the existing registration unmounts', async () => {
    const providerRegistry = createControlInteractionRegistry();
    const unregisterExisting = providerRegistry.register({
      identity: { formId: 'shared-form', controlId: 'shared-name' },
      metadata: { kind: 'text', label: 'Existing' },
      getValue: () => 'existing value',
    });
    const view = render(Fixture, {
      props: {
        providerRegistry,
        explicitRegistry: createControlInteractionRegistry(),
      },
    });
    await tick();

    expect(
      providerRegistry.get({
        formId: 'shared-form',
        controlId: 'shared-name',
      })?.state.value,
    ).toBe('existing value');
    unregisterExisting();
    await tick();
    expect(
      providerRegistry.get({
        formId: 'shared-form',
        controlId: 'shared-name',
      })?.metadata.label,
    ).toBe('Shared name');
    view.unmount();
    expect(
      providerRegistry.get({
        formId: 'shared-form',
        controlId: 'shared-name',
      }),
    ).toBeUndefined();
  });

  it('recovers after its shared identity is displaced and removed', async () => {
    const providerRegistry = createControlInteractionRegistry();
    const view = render(Fixture, {
      props: {
        providerRegistry,
        explicitRegistry: createControlInteractionRegistry(),
      },
    });
    await tick();

    const unregisterReplacement = providerRegistry.register({
      identity: { formId: 'shared-form', controlId: 'shared-name' },
      metadata: { kind: 'text', label: 'Replacement' },
      getValue: () => 'replacement value',
    });
    await tick();
    expect(
      providerRegistry.get({
        formId: 'shared-form',
        controlId: 'shared-name',
      })?.state.value,
    ).toBe('replacement value');

    unregisterReplacement();
    await tick();
    expect(
      providerRegistry.get({
        formId: 'shared-form',
        controlId: 'shared-name',
      })?.metadata.label,
    ).toBe('Shared name');
    view.unmount();
  });

  it('contains duplicate Provider prefixes without crashing the app', async () => {
    const names: string[] = [];
    document.modelContext = {
      registerTool(tool) {
        names.push(tool.name);
      },
    };
    const first = render(Fixture, {
      props: {
        providerRegistry: createControlInteractionRegistry(),
        explicitRegistry: createControlInteractionRegistry(),
      },
    });
    await tick();
    const second = render(Fixture, {
      props: {
        providerRegistry: createControlInteractionRegistry(),
        explicitRegistry: createControlInteractionRegistry(),
      },
    });
    await tick();

    expect(names).toHaveLength(6);
    second.unmount();
    first.unmount();
  });

  it('isolates throwing interaction observers from registry command outcomes', async () => {
    const providerRegistry = createControlInteractionRegistry();
    const view = render(Fixture, {
      props: {
        providerRegistry,
        explicitRegistry: createControlInteractionRegistry(),
        onSiblingInteraction: () => {
          throw new Error('observer failed');
        },
      },
    });
    await tick();

    await expect(
      providerRegistry.execute({
        action: 'stage',
        identity: { formId: 'sibling-form', controlId: 'sibling-name' },
        value: 'still staged',
      }),
    ).resolves.toMatchObject({ ok: true, action: 'stage' });
    view.unmount();
  });

  it('preserves legacy object configs that did not opt into UI tools', async () => {
    const names: string[] = [];
    const providerRegistry = createControlInteractionRegistry();
    document.modelContext = {
      registerTool(tool) {
        names.push(tool.name);
      },
    };
    const view = render(Fixture, {
      props: {
        providerRegistry,
        explicitRegistry: createControlInteractionRegistry(),
        enableUi: false,
      },
    });
    await tick();

    expect(names).toEqual([]);
    expect(providerRegistry.list()).toEqual([]);
    view.unmount();
  });
});
