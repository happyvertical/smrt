import { render } from '@testing-library/svelte';
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
    isInitializing: false,
    downloadProgress: 0,
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import FormWithFields from './form-with-fields.fixture.svelte';

afterEach(() => {
  delete document.modelContext;
});

describe('Form WebMCP submit intent', () => {
  it('registers a field-derived tool and dispatches validation + submit', async () => {
    const registered: Array<{
      name: string;
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const onsubmit = vi.fn();
    render(FormWithFields, { props: { webmcp: true, onsubmit } });
    await tick();
    await tick();

    expect(registered).toHaveLength(1);
    expect(registered[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { fullname: { type: 'string' }, age: { type: 'number' } },
    });
    expect(registered[0].name).toContain('submit');

    const result = await registered[0].execute({
      fullname: 'Ada Lovelace',
      age: 36,
    });
    expect(result).toBe('Submitted successfully');
    expect(onsubmit).toHaveBeenCalledWith({
      fullname: 'Ada Lovelace',
      age: 36,
    });
  });

  it('keeps the browser path a no-op without WebMCP', async () => {
    const onsubmit = vi.fn();
    const view = render(FormWithFields, { props: { onsubmit } });
    await userEvent.click(view.getByRole('button', { name: 'Submit' }));
    expect(onsubmit).toHaveBeenCalledTimes(1);
  });
});
