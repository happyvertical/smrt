import {
  createControlInteractionRegistry,
  executeLocalControlBatch,
} from '@happyvertical/smrt-ui/forms';
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

describe('Form WebMCP staged-edit intent', () => {
  it('registers a field-derived tool and stages without mutating or submitting', async () => {
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
    expect(registered[0].name).toContain('stage_changes');

    const result = await registered[0].execute({
      fullname: 'Ada Lovelace',
      age: 36,
    });
    expect(result).toBe('Staged 2 changes for review');
    expect(onsubmit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Review proposed changes' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('');
  });

  it('publishes constraints and leaves validation outcomes in the review workflow', async () => {
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

    expect(await registered[0].execute({ age: 17 })).toBe(
      'Staged 1 change for review',
    );
    expect(onsubmit).not.toHaveBeenCalled();

    expect(await registered[0].execute({ fullname: 'Ada', age: 36 })).toBe(
      'Staged 2 changes for review',
    );
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('does not expose or stage disabled rich fields', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const view = render(FormWithFields, {
      props: { webmcp: true, textDisabled: false, showAge: false },
    });
    await tick();
    await tick();

    expect(registered.at(-1)?.inputSchema).toMatchObject({
      properties: { fullname: { type: 'string' } },
    });

    await view.rerender({
      webmcp: true,
      textDisabled: true,
      showAge: false,
    });
    await tick();
    await tick();

    const tool = registered.at(-1);
    expect(tool?.inputSchema).toMatchObject({ properties: {} });
    expect(await tool?.execute({ fullname: 'Ada Lovelace' })).toBe(
      'No reviewable changes provided',
    );
    expect(screen.getByRole('textbox', { name: 'Full name' })).toBeDisabled();
  });

  it('does not expose fields disabled by an ancestor fieldset', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    render(FormWithFields, {
      props: {
        webmcp: true,
        fieldsetDisabled: true,
        showAge: false,
      },
    });
    await tick();
    await tick();

    const tool = registered.at(-1);
    expect(tool?.inputSchema).toMatchObject({ properties: {} });
    expect(await tool?.execute({ fullname: 'Ada Lovelace' })).toBe(
      'No reviewable changes provided',
    );
    expect(screen.getByRole('textbox', { name: 'Full name' })).toBeDisabled();
  });

  it('uses the form subject for rich-field registration and staging', async () => {
    const registered: Array<{
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const view = render(FormWithFields, {
      props: {
        webmcp: true,
        showAge: false,
        formSubject: { type: 'person', id: 'person-1' },
      },
    });
    await tick();
    await tick();

    expect(await registered.at(-1)?.execute({ fullname: 'Ada' })).toBe(
      'Staged 1 change for review',
    );
    expect(await screen.findByText(/person:person-1/)).toBeInTheDocument();

    await view.rerender({
      webmcp: true,
      showAge: false,
      formSubject: { type: 'person', id: 'person-2' },
    });
    await tick();
    await tick();
    expect(await registered.at(-1)?.execute({ fullname: 'Grace' })).toBe(
      'Staged 1 change for review',
    );
    expect(await screen.findByText(/person:person-2/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Mutate subject' }),
    );
    await tick();
    expect(await registered.at(-1)?.execute({ fullname: 'Katherine' })).toBe(
      'Staged 1 change for review',
    );
    expect(
      await screen.findByText(/person:person-mutated/),
    ).toBeInTheDocument();
  });

  it('publishes money in integer minor units and applies cents without rescaling', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithFields, {
      props: {
        webmcp: true,
        showAge: false,
        showMoney: true,
        interactionRegistry: registry,
      },
    });
    await tick();
    await tick();

    expect(registered.at(-1)?.inputSchema).toMatchObject({
      properties: {
        budget: {
          type: 'integer',
          description:
            'A monetary amount in dollars. WebMCP values use integer minor units (cents).',
        },
      },
    });
    expect(await registered.at(-1)?.execute({ budget: 1234 })).toBe(
      'Staged 1 change for review',
    );
    const budget = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'budget');
    expect(budget?.state.staged?.value).toBe(1234);
    expect(
      await executeLocalControlBatch(
        registry,
        [
          {
            action: 'apply',
            identity: budget?.identity ?? { formId: '', controlId: '' },
            revision: budget?.state.staged?.revision,
          },
        ],
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    expect(
      registry
        .list()
        .find((snapshot) => snapshot.identity.controlId === 'budget')?.state
        .value,
    ).toBe(1234);
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
      registerTool(tool) {
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
    expect(await registered[0].execute(values)).toBe(
      'Staged 3 changes for review',
    );
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('limits the address schema and payload to configured fields', async () => {
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
    expect(await registered[0].execute(values)).toBe(
      'Staged 3 changes for review',
    );
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('allows partial payloads for optional structured fields', async () => {
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
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithStructuredFields, {
      props: {
        webmcp: true,
        structuredRequired: false,
        onsubmit,
        interactionRegistry: registry,
      },
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
      'Staged 3 changes for review',
    );
    expect(onsubmit).not.toHaveBeenCalled();
    const staged = registry
      .list('structured-fields')
      .filter((snapshot) => snapshot.state.staged)
      .map((snapshot) => ({
        action: 'apply' as const,
        identity: snapshot.identity,
        revision: snapshot.state.staged?.revision,
      }));
    const applied = await executeLocalControlBatch(
      registry,
      staged,
      new Event('click'),
    );
    expect(applied.results).toEqual(
      staged.map((command) =>
        expect.objectContaining({
          ok: true,
          identity: command.identity,
        }),
      ),
    );
    expect(registry.list('structured-fields')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ controlId: 'dates' }),
          state: expect.objectContaining({
            value: { startDate: '2026-01-01', endDate: '' },
          }),
        }),
        expect.objectContaining({
          identity: expect.objectContaining({ controlId: 'address' }),
          state: expect.objectContaining({
            value: expect.objectContaining({
              city: 'Edmonton',
              country: 'CA',
            }),
          }),
        }),
      ]),
    );
  });

  it('does not expose structured fields disabled by an ancestor fieldset', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    render(FormWithStructuredFields, {
      props: { webmcp: true, fieldsetDisabled: true },
    });
    await tick();
    await tick();

    const tool = registered.at(-1);
    expect(tool?.inputSchema).toMatchObject({ properties: {} });
    expect(await tool?.execute({ address: { city: 'Edmonton' } })).toBe(
      'No reviewable changes provided',
    );
  });
});
