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

  it('publishes required and numeric constraints and validates them before submit', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const onsubmit = vi.fn();
    render(FormWithFields, {
      props: {
        webmcp: true,
        textRequired: true,
        ageRequired: true,
        ageMin: 18,
        ageMax: 65,
        onsubmit,
      },
    });
    await tick();
    await tick();

    expect(registered).toHaveLength(1);
    const schema = registered[0].inputSchema as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toEqual(['fullname', 'age']);
    expect(schema.properties.age).toMatchObject({
      type: 'number',
      minimum: 18,
      maximum: 65,
    });

    expect(await registered[0].execute({ age: 17 })).toBe('Validation failed');
    expect(await registered[0].execute({ fullname: 'Ada', age: 66 })).toBe(
      'Validation failed',
    );
    expect(onsubmit).not.toHaveBeenCalled();

    expect(await registered[0].execute({ fullname: 'Ada', age: 36 })).toBe(
      'Submitted successfully',
    );
    expect(onsubmit).toHaveBeenCalledWith({ fullname: 'Ada', age: 36 });
  });

  it('keeps the browser path a no-op without WebMCP', async () => {
    const onsubmit = vi.fn();
    const view = render(FormWithFields, { props: { onsubmit } });
    await userEvent.click(view.getByRole('button', { name: 'Submit' }));
    expect(onsubmit).toHaveBeenCalledTimes(1);
  });
});
