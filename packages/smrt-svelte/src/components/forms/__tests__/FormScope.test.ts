import { createControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import { render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fixture from './form-scope.fixture.svelte';

type RegisteredTool = {
  name: string;
  inputSchema: { properties: Record<string, unknown> };
  execute: (args: Record<string, unknown>) => Promise<string>;
};

afterEach(() => {
  delete document.modelContext;
});

describe('FormScope', () => {
  it('registers a stage-only tool for the smrt-ui controls inside a plain container', async () => {
    const registered: RegisteredTool[] = [];
    document.modelContext = {
      async registerTool(tool) {
        registered.push(tool as RegisteredTool);
      },
    };
    const registry = createControlInteractionRegistry();
    const { container, rerender } = render(Fixture, {
      props: { interactionRegistry: registry },
    });
    expect(container.querySelector('form')).toBeNull();
    await tick();
    await vi.waitFor(() => expect(registered.length).toBeGreaterThan(0));
    const tool = registered.at(-1) as RegisteredTool;
    expect(tool.name).toBe('new_site_stage_changes');
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      'name',
      'town',
    ]);

    const result = JSON.parse(
      await tool.execute({ name: 'Lacombe News', key: 'x' }),
    );
    expect(result).toMatchObject({ ok: true, staged: 1, skipped: ['key'] });
    expect(screen.getByRole('textbox', { name: 'Site name' })).toHaveValue('');
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Review proposed changes' }),
      ).toBeInTheDocument(),
    );

    const before = registered.length;
    await rerender({ interactionRegistry: registry, showTown: false });
    await vi.waitFor(() => expect(registered.length).toBeGreaterThan(before));
    expect(
      Object.keys((registered.at(-1) as RegisteredTool).inputSchema.properties),
    ).toEqual(['name']);
  });
});
