/**
 * The Svelte binding for declarative view intents (#2588).
 *
 * The contract, registry, and compilation are covered in
 * `@happyvertical/smrt-web` (`src/intents.test.ts`). What is proven HERE is
 * the binding: that a declared intent reaches WebMCP through the shared
 * `useWebMcpTool` lifecycle and the Provider's exposure policy, and that
 * executing it moves only mounted registry state.
 */

import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { createControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registerBespokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@happyvertical/smrt-web', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-web')>();
  registerBespokeSpy.mockImplementation(actual.registerWebMcpBespokeTool);
  return { ...actual, registerWebMcpBespokeTool: registerBespokeSpy };
});

import Fixture from './view-intent.fixture.svelte';
import {
  clearNotesIntent,
  nextPageIntent,
  revealNotesIntent,
  stageNotesIntent,
} from './view-intent.intents.js';
import ProviderFixture from './view-intent-provider.fixture.svelte';

interface RegisteredTool {
  name: string;
  annotations?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
  signal?: AbortSignal;
}

function installModelContext(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  document.modelContext = {
    async registerTool(
      tool: RegisteredTool,
      options?: { signal?: AbortSignal },
    ) {
      registered.push({ ...tool, signal: options?.signal });
    },
  } as unknown as Document['modelContext'];
  return registered;
}

function mountedControlRegistry() {
  const registry = createControlInteractionRegistry();
  let value = 'before';
  registry.register({
    identity: { formId: 'order-form', controlId: 'notes' },
    metadata: { kind: 'text', label: 'Notes', readable: true, writable: true },
    getValue: () => value,
    setValue: (next: unknown) => {
      value = String(next);
    },
  });
  return registry;
}

afterEach(() => {
  document.modelContext = undefined;
  registerBespokeSpy.mockClear();
});

describe('useViewIntent', () => {
  it('registers a declared intent on mount and deregisters on unmount', async () => {
    const registered = installModelContext();
    const view = render(Fixture, {
      props: {
        intent: revealNotesIntent,
        identity: { formId: 'order-form', controlId: 'notes' },
        controlRegistry: mountedControlRegistry(),
      },
    });

    await vi.waitFor(() => expect(registered).toHaveLength(1));
    expect(registered[0].name).toBe('fixture_reveal_notes');
    expect(registered[0].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      untrustedContentHint: true,
    });
    expect(registered[0].signal?.aborted).toBe(false);

    view.unmount();
    expect(registered[0].signal?.aborted).toBe(true);
  });

  it('routes through registerWebMcpBespokeTool, never document.modelContext directly', async () => {
    installModelContext();
    render(Fixture, {
      props: {
        intent: revealNotesIntent,
        identity: { formId: 'order-form', controlId: 'notes' },
        controlRegistry: mountedControlRegistry(),
      },
    });

    await vi.waitFor(() => expect(registerBespokeSpy).toHaveBeenCalledTimes(1));
    expect(registerBespokeSpy.mock.calls[0][0]).toMatchObject({
      name: 'fixture_reveal_notes',
    });
  });

  it('resolves the mounted registries from the nearest Provider', async () => {
    const registered = installModelContext();
    const registry = mountedControlRegistry();
    render(ProviderFixture, {
      props: {
        intent: revealNotesIntent,
        identity: { formId: 'order-form', controlId: 'notes' },
        providerRegistry: registry,
      },
    });

    await vi.waitFor(() => expect(registered).toHaveLength(1));
    expect(registered[0].name).toBe('fixture_reveal_notes');
  });

  it("applies the Provider's effects policy to an intent", async () => {
    const registered = installModelContext();
    // `clearNotesIntent` declares no capability, so it classifies
    // fail-closed as destructive and a read-only Provider excludes it.
    render(ProviderFixture, {
      props: {
        intent: clearNotesIntent,
        identity: { formId: 'order-form', controlId: 'notes' },
        providerRegistry: mountedControlRegistry(),
        effects: ['read'],
      },
    });

    await vi.waitFor(() => expect(registerBespokeSpy).toHaveBeenCalledTimes(1));
    expect(registerBespokeSpy.mock.calls[0][1]).toEqual({ effects: ['read'] });
    expect(registered).toHaveLength(0);
  });

  it('executes by dispatching one agent-sourced registry command', async () => {
    const registered = installModelContext();
    const registry = mountedControlRegistry();
    const executeSpy = vi.spyOn(registry, 'execute');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(ProviderFixture, {
      props: {
        intent: stageNotesIntent,
        identity: { formId: 'order-form', controlId: 'notes' },
        providerRegistry: registry,
        effects: ['read', 'write'],
      },
    });
    await vi.waitFor(() => expect(registered).toHaveLength(1));

    await registered[0].execute({ value: 'after' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0][0]).toEqual({
      action: 'stage',
      identity: { formId: 'order-form', controlId: 'notes' },
      value: 'after',
    });
    // Agent-staged values stay proposals: the command is dispatched as
    // `source: 'agent'`, so StagedControlReview and the local-gesture
    // requirement apply unchanged.
    expect(executeSpy.mock.calls[0][1]).toEqual({ source: 'agent' });
  });

  it('binds a data-surface intent to a mounted surface identity', async () => {
    const registered = installModelContext();
    const registry = createDataSurfaceRegistry();
    const executeSpy = vi.spyOn(registry, 'execute');

    render(Fixture, {
      props: {
        intent: nextPageIntent,
        identity: { surfaceId: 'orders-table', kind: 'table' },
        dataSurfaceRegistry: registry,
      },
    });
    await vi.waitFor(() => expect(registered).toHaveLength(1));
    expect(registered[0].name).toBe('fixture_next_page');

    // Nothing is mounted under that identity, so the intent reports
    // not_found rather than inventing a command.
    expect(JSON.parse(String(await registered[0].execute({})))).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('is a no-op with no Provider and no explicit registry', async () => {
    const registered = installModelContext();
    render(Fixture, {
      props: {
        intent: revealNotesIntent,
        identity: { formId: 'order-form', controlId: 'notes' },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registered).toHaveLength(0);
    expect(registerBespokeSpy).not.toHaveBeenCalled();
  });

  it('rejects an identity that does not match the declared target registry', () => {
    installModelContext();
    expect(() =>
      render(Fixture, {
        props: {
          intent: revealNotesIntent,
          identity: { surfaceId: 'orders-table', kind: 'table' },
          controlRegistry: mountedControlRegistry(),
        },
      }),
    ).toThrow(/needs a \{ formId, controlId \} identity/);
  });
});
