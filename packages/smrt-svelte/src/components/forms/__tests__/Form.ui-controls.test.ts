import { createControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => ({
    isListening: false,
    lastResult: '',
    isReady: false,
    adapterType: null,
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import Fixture from './form-with-ui-controls.fixture.svelte';

type RegisteredTool = {
  name: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

function captureTools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  document.modelContext = {
    async registerTool(tool) {
      registered.push(tool as RegisteredTool);
    },
  };
  return registered;
}

afterEach(() => {
  delete document.modelContext;
});

describe('rich Form: native attributes, enhance, and smrt-ui controls', () => {
  it('passes native form attributes and attachments through to <form>', async () => {
    const attach = vi.fn();
    render(Fixture, { props: { attach } });
    const form = screen.getByTestId('network-form');
    expect(form.tagName).toBe('FORM');
    expect(form).toHaveAttribute('enctype', 'multipart/form-data');
    expect(form).toHaveAttribute('novalidate');
    expect(form).toHaveAttribute('method', 'POST');
    expect(form).toHaveAttribute('action', '?/create');
    expect(form).toHaveAccessibleName('Set up your network');
    expect(attach).toHaveBeenCalledWith(form);
  });

  it('applies an enhance action to the form and tears it down on unmount', () => {
    const destroy = vi.fn();
    const enhance = vi.fn(() => ({ destroy }));
    const { unmount } = render(Fixture, { props: { enhance } });
    expect(enhance).toHaveBeenCalledWith(screen.getByTestId('network-form'));
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('lets an enhanced submit through without preventing it', async () => {
    let submitted: SubmitEvent | undefined;
    const enhance = (form: HTMLFormElement) => {
      const listener = (event: SubmitEvent) => {
        submitted = event;
        event.preventDefault();
      };
      form.addEventListener('submit', listener);
      return { destroy: () => form.removeEventListener('submit', listener) };
    };
    render(Fixture, { props: { enhance } });
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(submitted).toBeDefined();
  });

  it('describes smrt-ui controls and rich fields in one stage-only tool', async () => {
    const registered = captureTools();
    render(Fixture);
    await tick();
    await vi.waitFor(() => expect(registered.length).toBeGreaterThan(0));
    const tool = registered.at(-1) as RegisteredTool;
    expect(tool.name).toBe('setup-network_stage_changes');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        tagline: { type: 'string', title: 'Tagline' },
        name: { type: 'string', title: 'Network name' },
        kind: { type: 'string', title: 'Kind of network' },
        town: {
          type: 'string',
          title: 'Home town',
          enum: ['lacombe', 'blackfalds'],
        },
      },
    });
  });

  it('stages smrt-ui control proposals for review and never writes them', async () => {
    const registered = captureTools();
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { interactionRegistry: registry } });
    await tick();
    await vi.waitFor(() => expect(registered.length).toBeGreaterThan(0));
    const tool = registered.at(-1) as RegisteredTool;
    const result = await tool.execute({
      name: 'Central Alberta News',
      town: 'blackfalds',
      tagline: 'Local first',
    });
    expect(result).toBe('Staged 3 changes for review');
    expect(screen.getByRole('textbox', { name: 'Network name' })).toHaveValue(
      '',
    );
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Review proposed changes' }),
      ).toBeInTheDocument(),
    );
    expect(
      registry.get({ formId: 'setup-network', controlId: 'name' })?.state.staged
        ?.value,
    ).toBe('Central Alberta News');
    expect(screen.queryByText(/setup-network\//)).not.toBeInTheDocument();
  });

  it('marks a staged smrt-ui proposal stale when the person types over it', async () => {
    const registered = captureTools();
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { interactionRegistry: registry } });
    await tick();
    await vi.waitFor(() => expect(registered.length).toBeGreaterThan(0));
    await (registered.at(-1) as RegisteredTool).execute({ name: 'Proposed' });
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Network name' }),
      'Mine',
    );
    await waitFor(() =>
      expect(
        registry.get({ formId: 'setup-network', controlId: 'name' })?.state
          .staged?.stale,
      ).toBe(true),
    );
  });
});
