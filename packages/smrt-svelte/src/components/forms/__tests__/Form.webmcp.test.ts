import {
  createControlInteractionRegistry,
  executeLocalControlBatch,
} from '@happyvertical/smrt-ui/forms';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appState = vi.hoisted(() => ({ mode: 'default' }));

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: appState, setMode: vi.fn() }),
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
  appState.mode = 'default';
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

  it('returns focus to a rich field after applying its final proposal', async () => {
    const registered: Array<{
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const interactionRegistry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithFields, {
      props: { webmcp: true, showAge: false, interactionRegistry },
    });
    await tick();
    await tick();
    await registered.at(-1)?.execute({ fullname: 'Ada Lovelace' });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply valid changes' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveFocus(),
    );
  });

  it('preserves staged state when an unrelated sibling field mounts', async () => {
    const registered: Array<{
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
    const view = render(FormWithFields, {
      props: { webmcp: true, interactionRegistry: registry },
    });
    await tick();
    await tick();
    expect(await registered.at(-1)?.execute({ fullname: 'Ada' })).toBe(
      'Staged 1 change for review',
    );

    await view.rerender({
      webmcp: true,
      interactionRegistry: registry,
      showMoney: true,
    });
    await tick();

    expect(
      registry
        .list()
        .find((snapshot) => snapshot.identity.controlId === 'fullname')?.state
        .staged?.value,
    ).toBe('Ada');

    const fullname = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'fullname');
    if (!fullname) throw new Error('fullname was not registered');
    expect(
      await executeLocalControlBatch(
        registry,
        [
          {
            action: 'apply',
            identity: fullname.identity,
            revision: fullname.state.staged?.revision,
          },
        ],
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    await view.rerender({
      webmcp: true,
      interactionRegistry: registry,
      showMoney: false,
    });
    await tick();
    expect(
      await executeLocalControlBatch(
        registry,
        [{ action: 'undo', identity: fullname.identity }],
        new Event('click'),
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(fullname.identity)?.state.value).toBe('');
  });

  it('rejects invalid rich numeric proposals before mutation callbacks run', async () => {
    const numberChanged = vi.fn();
    const measurementChanged = vi.fn();
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithFields, {
      props: {
        interactionRegistry: registry,
        onnumberchange: numberChanged,
        ageStep: 2,
      },
    });
    render(FormWithStructuredFields, {
      props: {
        interactionRegistry: registry,
        onmeasurementchange: measurementChanged,
        measurementStep: 2,
      },
    });
    await tick();
    const ageIdentity = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'age')?.identity;
    if (!ageIdentity) throw new Error('age control was not registered');
    const measurementIdentity = {
      formId: 'structured-fields',
      controlId: 'measurement',
    };
    const applyStaged = () =>
      executeLocalControlBatch(
        registry,
        registry
          .list()
          .filter((snapshot) => snapshot.state.staged)
          .map((snapshot) => ({
            action: 'apply' as const,
            identity: snapshot.identity,
            revision: snapshot.state.staged?.revision,
          })),
        new Event('click'),
      );

    await registry.execute(
      {
        action: 'stage',
        identity: ageIdentity,
        value: Number.POSITIVE_INFINITY,
      },
      { source: 'agent' },
    );
    await registry.execute(
      {
        action: 'stage',
        identity: measurementIdentity,
        value: { value: Number.POSITIVE_INFINITY, unit: 'ft' },
      },
      { source: 'agent' },
    );

    const results = await applyStaged();
    expect(results.results).toHaveLength(2);
    expect(results.results.every((result) => !result.ok)).toBe(true);

    await registry.execute(
      { action: 'stage', identity: ageIdentity, value: 3 },
      { source: 'agent' },
    );
    await registry.execute(
      {
        action: 'stage',
        identity: measurementIdentity,
        value: { value: 3, unit: 'ft' },
      },
      { source: 'agent' },
    );
    expect((await applyStaged()).results.every((result) => !result.ok)).toBe(
      true,
    );

    await registry.execute(
      {
        action: 'stage',
        identity: measurementIdentity,
        value: { value: 2, unit: 'constructor' },
      },
      { source: 'agent' },
    );
    expect((await applyStaged()).results.every((result) => !result.ok)).toBe(
      true,
    );
    expect(numberChanged).not.toHaveBeenCalled();
    expect(measurementChanged).not.toHaveBeenCalled();
  });

  it('rejects a non-object date-range proposal without delayed mutation', async () => {
    const datesChanged = vi.fn();
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithStructuredFields, {
      props: {
        interactionRegistry: registry,
        ondateschange: datesChanged,
      },
    });
    await tick();
    const identity = { formId: 'structured-fields', controlId: 'dates' };
    await registry.execute(
      { action: 'stage', identity, value: 'next week' },
      { source: 'agent' },
    );
    const revision = registry.get(identity)?.state.staged?.revision;

    expect(
      await executeLocalControlBatch(
        registry,
        [{ action: 'apply', identity, revision }],
        new Event('click'),
      ),
    ).toMatchObject({ ok: false });
    await Promise.resolve();
    expect(datesChanged).not.toHaveBeenCalled();
  });

  it('affirms idempotent clears for empty composite fields', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithStructuredFields, {
      props: {
        interactionRegistry: registry,
        structuredRequired: false,
      },
    });
    await tick();

    expect(
      await executeLocalControlBatch(
        registry,
        [
          {
            action: 'clear',
            identity: { formId: 'structured-fields', controlId: 'dates' },
          },
          {
            action: 'clear',
            identity: {
              formId: 'structured-fields',
              controlId: 'measurement',
            },
          },
        ],
        new Event('click'),
      ),
    ).toMatchObject({
      ok: true,
      results: [{ ok: true }, { ok: true }],
    });
  });

  it('rejects invalid structured proposals before mutation callbacks run', async () => {
    const addressChanged = vi.fn();
    const datesChanged = vi.fn();
    const measurementChanged = vi.fn();
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithStructuredFields, {
      props: {
        interactionRegistry: registry,
        structuredRequired: false,
        addressFields: ['city'],
        onaddresschange: addressChanged,
        ondateschange: datesChanged,
        onmeasurementchange: measurementChanged,
        measurementUnits: ['m'],
        minDate: '2026-08-01',
        maxDate: '2026-08-31',
      },
    });
    await tick();
    const apply = async (controlId: string, value: unknown) => {
      const identity = { formId: 'structured-fields', controlId };
      await registry.execute(
        { action: 'stage', identity, value },
        { source: 'agent' },
      );
      return executeLocalControlBatch(
        registry,
        [
          {
            action: 'apply',
            identity,
            revision: registry.get(identity)?.state.staged?.revision,
          },
        ],
        new Event('click'),
      );
    };

    expect(
      (await apply('address', { city: { nested: true } })).results[0].ok,
    ).toBe(false);
    expect(
      (await apply('address', { city: 'Edmonton', constructor: 'payload' }))
        .results[0].ok,
    ).toBe(false);
    expect(
      (
        await apply('dates', {
          startDate: '2026-08-30',
          endDate: '2026-08-20',
        })
      ).results[0].ok,
    ).toBe(false);
    expect(
      (
        await apply('dates', {
          startDate: '2026-02-30',
          endDate: '2026-08-20',
        })
      ).results[0].ok,
    ).toBe(false);
    expect(
      (
        await apply('dates', {
          startDate: '2026-07-31',
          endDate: '2026-08-20',
        })
      ).results[0].ok,
    ).toBe(false);
    expect(
      (
        await apply('dates', {
          startDate: '2026-08-10',
          endDate: '2026-08-20',
          constructor: 'payload',
        })
      ).results[0].ok,
    ).toBe(false);
    expect(
      (await apply('measurement', { value: 2, unit: 'ft' })).results[0].ok,
    ).toBe(false);
    expect(
      (
        await apply('measurement', {
          value: 2,
          unit: 'm',
          constructor: 'payload',
        })
      ).results[0].ok,
    ).toBe(false);
    expect(addressChanged).not.toHaveBeenCalled();
    expect(datesChanged).not.toHaveBeenCalled();
    expect(measurementChanged).not.toHaveBeenCalled();
  });

  it('returns focus to smrt-mode DateRangeInput after final discard', async () => {
    appState.mode = 'smrt';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithStructuredFields, {
      props: { interactionRegistry: registry },
    });
    await tick();
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'structured-fields', controlId: 'dates' },
        value: { startDate: '2026-08-26', endDate: '2026-08-27' },
      },
      { source: 'agent' },
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Discard valid changes' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /date range/i })).toHaveFocus(),
    );
  });

  it('falls back to an enabled form control after discarding a disabled field', async () => {
    appState.mode = 'smrt';
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    const view = render(FormWithStructuredFields, {
      props: { interactionRegistry: registry },
    });
    await tick();
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'structured-fields', controlId: 'dates' },
        value: { startDate: '2026-08-26', endDate: '2026-08-27' },
      },
      { source: 'agent' },
    );
    await view.rerender({
      interactionRegistry: registry,
      dateDisabled: true,
    });
    await tick();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Discard valid changes' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Submit' })).toHaveFocus(),
    );
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
        moneyMin: 100,
        moneyMax: 5000,
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
            'A monetary amount in dollars (between $1.00 and $50.00). WebMCP values use integer minor units (cents).',
          minimum: 100,
          maximum: 5000,
        },
      },
    });
    expect(await registered.at(-1)?.execute({ budget: 123.5 })).toBe(
      'Staged 1 change for review',
    );
    expect(
      registry
        .list()
        .find((snapshot) => snapshot.identity.controlId === 'budget')?.state
        .staged,
    ).toMatchObject({ value: 123.5, valid: false });
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
      additionalProperties: false,
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

  it('stages through an additive legacy registry without executeBatch', async () => {
    const registered: Array<{
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const baseRegistry = createControlInteractionRegistry();
    const { executeBatch: _executeBatch, ...legacyRegistry } = baseRegistry;
    render(FormWithFields, {
      props: {
        webmcp: true,
        showAge: false,
        interactionRegistry: legacyRegistry,
      },
    });
    await tick();
    await tick();

    expect(await registered.at(-1)?.execute({ fullname: 'Ada' })).toBe(
      'Staged 1 change for review',
    );
    expect(legacyRegistry.list()[0]?.state.staged?.value).toBe('Ada');
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
    const registry = createControlInteractionRegistry();
    render(FormWithStructuredFields, {
      props: {
        webmcp: true,
        addressFields: ['city', 'country'],
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
      address: { city: 'Edmonton', country: 'CA', street: 'hidden' },
    };
    expect(await registered[0].execute(values)).toBe(
      'Staged 3 changes for review',
    );
    expect(onsubmit).not.toHaveBeenCalled();
    expect(
      registry
        .list('structured-fields')
        .find((snapshot) => snapshot.identity.controlId === 'address')?.state
        .staged?.value,
    ).toEqual({ city: 'Edmonton', country: 'CA' });
  });

  it('updates configured rich-field schemas after prop changes', async () => {
    const registered: Array<{ inputSchema: Record<string, unknown> }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const view = render(FormWithStructuredFields, {
      props: {
        webmcp: true,
        addressFields: ['city'],
        measurementUnits: ['m'],
      },
    });
    await tick();
    await tick();

    await view.rerender({
      webmcp: true,
      addressFields: ['country'],
      measurementUnits: ['ft'],
    });
    await tick();
    await tick();

    const schema = registered.at(-1)?.inputSchema as {
      properties: Record<
        string,
        { properties: Record<string, { enum?: string[] }> }
      >;
    };
    expect(schema.properties.address.properties).toEqual({
      country: { type: 'string' },
    });
    expect(schema.properties.measurement.properties.unit.enum).toEqual(['ft']);
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
    appState.mode = 'smrt';
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

  it('does not let a colliding sibling name mask a disabled rich field', async () => {
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
      props: {
        webmcp: true,
        fieldsetDisabled: true,
        measurementName: 'user',
        showCollidingSibling: true,
      },
    });
    await tick();
    await tick();

    expect(registered.at(-1)?.inputSchema).toMatchObject({ properties: {} });
    expect(
      await registered.at(-1)?.execute({ user: { value: 2, unit: 'm' } }),
    ).toBe('No reviewable changes provided');
  });

  it('removes a smrt-mode date range when its fieldset becomes disabled', async () => {
    appState.mode = 'smrt';
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const view = render(FormWithStructuredFields, {
      props: { webmcp: true },
    });
    await tick();
    await tick();
    expect(registered.at(-1)?.inputSchema).toMatchObject({
      properties: { dates: expect.any(Object) },
    });

    await view.rerender({ webmcp: true, fieldsetDisabled: true });
    await tick();
    await tick();

    expect(registered.at(-1)?.inputSchema).toMatchObject({ properties: {} });
    expect(
      await registered.at(-1)?.execute({
        dates: { startDate: '2026-08-26', endDate: '2026-08-27' },
      }),
    ).toBe('No reviewable changes provided');
  });
});
