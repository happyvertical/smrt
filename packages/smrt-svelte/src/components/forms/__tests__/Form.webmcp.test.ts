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
import FormWithStructuredFields from './form-with-structured-fields.fixture.svelte';

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
      async registerTool(tool) {
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
      async registerTool(tool) {
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

  it('publishes and accepts structured measurement, date range, and address fields', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      async registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const onsubmit = vi.fn();
    render(FormWithStructuredFields, { props: { webmcp: true, onsubmit } });
    await tick();
    await tick();

    expect(registered).toHaveLength(1);
    const schema = registered[0].inputSchema as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toEqual(['measurement', 'dates', 'address']);
    expect(schema.properties.measurement).toMatchObject({
      type: 'object',
      properties: {
        value: { type: 'number' },
        unit: { type: 'string' },
      },
      required: ['value', 'unit'],
    });
    expect(schema.properties.dates).toMatchObject({
      type: 'object',
      properties: {
        startDate: { type: 'string' },
        endDate: { type: 'string' },
      },
      required: ['startDate', 'endDate'],
    });
    expect(schema.properties.address).toMatchObject({
      type: 'object',
      properties: {
        street: { type: 'string' },
        city: { type: 'string' },
        province: { type: 'string' },
        postalCode: { type: 'string' },
        country: { type: 'string' },
      },
      required: ['street', 'city', 'province', 'postalCode', 'country'],
    });

    const values = {
      measurement: { value: 1.5, unit: 'm' },
      dates: { startDate: '2026-01-01', endDate: '2026-01-02' },
      address: {
        street: '1 Main St',
        city: 'Edmonton',
        province: 'AB',
        postalCode: 'T1A 1A1',
        country: 'CA',
      },
    };
    expect(
      await registered[0].execute({
        ...values,
        address: {},
      }),
    ).toBe('Validation failed');
    expect(onsubmit).not.toHaveBeenCalled();

    expect(await registered[0].execute(values)).toBe('Submitted successfully');
    expect(onsubmit).toHaveBeenCalledWith(values);
  });

  it('limits the address schema and payload to configured fields', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      async registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const onsubmit = vi.fn();
    render(FormWithStructuredFields, {
      props: {
        webmcp: true,
        addressFields: ['city', 'country'],
        onsubmit,
      },
    });
    await tick();
    await tick();

    expect(registered).toHaveLength(1);
    const schema = registered[0].inputSchema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.address).toMatchObject({
      type: 'object',
      properties: {
        city: { type: 'string' },
        country: { type: 'string' },
      },
      required: ['city', 'country'],
    });
    expect(schema.properties.address.properties).not.toHaveProperty('street');

    const values = {
      measurement: { value: 1.5, unit: 'm' },
      dates: { startDate: '2026-01-01', endDate: '2026-01-02' },
      address: { city: 'Edmonton', country: 'CA' },
    };
    expect(await registered[0].execute(values)).toBe('Submitted successfully');
    expect(onsubmit).toHaveBeenCalledWith(values);
  });

  it('allows partial payloads for optional structured fields', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      async registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const onsubmit = vi.fn();
    render(FormWithStructuredFields, {
      props: { webmcp: true, structuredRequired: false, onsubmit },
    });
    await tick();
    await tick();

    expect(registered).toHaveLength(1);
    const schema = registered[0].inputSchema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.measurement).not.toHaveProperty('required');
    expect(schema.properties.dates).not.toHaveProperty('required');
    expect(schema.properties.address).not.toHaveProperty('required');

    const partialValues = {
      measurement: { value: 1.5 },
      dates: { startDate: '2026-01-01' },
      address: { city: 'Edmonton' },
    };
    expect(await registered[0].execute(partialValues)).toBe(
      'Submitted successfully',
    );
    expect(onsubmit).toHaveBeenCalledTimes(1);
  });
});
