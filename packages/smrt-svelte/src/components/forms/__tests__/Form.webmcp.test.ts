import {
  createControlInteractionRegistry,
  executeLocalControlBatch,
  executeLocalControlCommand,
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
import FormWithPolicyField from './form-with-policy-field.fixture.svelte';
import FormWithStructuredFields from './form-with-structured-fields.fixture.svelte';

afterEach(() => {
  delete document.modelContext;
  appState.mode = 'default';
});

function dispatchLocalGesture<T>(
  execute: (event: Event) => Promise<T>,
): Promise<T> {
  const target = new EventTarget();
  let pending: Promise<T> | undefined;
  target.addEventListener(
    'click',
    (event) => {
      pending = execute(event);
    },
    { once: true },
  );
  target.dispatchEvent(new Event('click'));
  if (!pending) throw new Error('local gesture handler did not run');
  return pending;
}

describe('Form WebMCP staged-edit intent', () => {
  it('registers a field-derived tool and stages without mutating or submitting', async () => {
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

  it('publishes rich control identity and staged state on the native field', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithFields, {
      props: {
        showAge: false,
        interactionRegistry: registry,
        formSubject: { type: 'person', id: 'person-1' },
      },
    });
    await tick();
    const fullname = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'fullname');
    if (!fullname) throw new Error('fullname was not registered');
    const input = screen.getByRole('textbox', { name: 'Full name' });
    expect(input).toHaveAttribute('data-smrt-control', 'fullname');
    expect(input).toHaveAttribute('data-smrt-form', fullname.identity.formId);
    expect(input).toHaveAttribute('data-smrt-subject-type', 'person');
    expect(input).toHaveAttribute('data-smrt-subject-id', 'person-1');

    await registry.execute(
      { action: 'stage', identity: fullname.identity, value: 'Ada' },
      { source: 'agent' },
    );
    await waitFor(() =>
      expect(input).toHaveAttribute('data-smrt-staged', 'true'),
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Discard valid changes' }),
    );
    await waitFor(() => expect(input).not.toHaveAttribute('data-smrt-staged'));
    expect(input).toHaveFocus();
  });

  it('marks empty required rich scalar proposals invalid before application', async () => {
    const registry = createControlInteractionRegistry();
    const textChanged = vi.fn();
    const checkboxChanged = vi.fn();
    const selectChanged = vi.fn();
    const notesChanged = vi.fn();
    render(FormWithFields, {
      props: {
        showAge: false,
        showClearFields: true,
        showScalarFields: true,
        textValue: 'Ada',
        notesValue: 'Existing',
        textRequired: true,
        checkboxRequired: true,
        selectRequired: true,
        notesRequired: true,
        interactionRegistry: registry,
        ontextchange: textChanged,
        oncheckboxchange: checkboxChanged,
        onselectchange: selectChanged,
        onnoteschange: notesChanged,
      },
    });
    await tick();

    const candidates = new Map<string, unknown>([
      ['fullname', '   '],
      ['enabled', false],
      ['choice', ''],
      ['notes', '   '],
    ]);
    const commands = [];
    for (const [controlId, value] of candidates) {
      const snapshot = registry
        .list()
        .find((item) => item.identity.controlId === controlId);
      if (!snapshot) throw new Error(`${controlId} was not registered`);
      await registry.execute(
        { action: 'stage', identity: snapshot.identity, value },
        { source: 'agent' },
      );
      expect(registry.get(snapshot.identity)?.state.staged).toMatchObject({
        valid: false,
      });
      commands.push({
        action: 'apply' as const,
        identity: snapshot.identity,
        revision: registry.get(snapshot.identity)?.state.staged?.revision,
      });
    }

    const applied = await dispatchLocalGesture((event) =>
      executeLocalControlBatch(registry, commands, event),
    );
    expect(applied.results).toHaveLength(4);
    expect(applied.results.every((result) => !result.ok)).toBe(true);
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );

    expect(screen.getByRole('textbox', { name: 'Full name*' })).toHaveValue(
      'Ada',
    );
    expect(screen.getByRole('checkbox', { name: 'Enabled*' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Choice*' })).toHaveValue(
      'second',
    );
    expect(screen.getByRole('textbox', { name: 'Notes*' })).toHaveValue(
      'Existing',
    );
    expect(textChanged).not.toHaveBeenCalled();
    expect(checkboxChanged).not.toHaveBeenCalled();
    expect(selectChanged).not.toHaveBeenCalled();
    expect(notesChanged).not.toHaveBeenCalled();
    expect(
      commands.every(
        (command) => registry.get(command.identity)?.state.staged !== undefined,
      ),
    ).toBe(true);
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
      await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [
            {
              action: 'apply',
              identity: fullname.identity,
              revision: fullname.state.staged?.revision,
            },
          ],
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    await view.rerender({
      webmcp: true,
      interactionRegistry: registry,
      showMoney: false,
    });
    await tick();
    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [{ action: 'undo', identity: fullname.identity }],
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(fullname.identity)?.state.value).toBe('');
  });

  it('preserves staged and undo state across live field label changes', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    const view = render(FormWithFields, {
      props: {
        interactionRegistry: registry,
        ageLabel: 'Minimum age',
      },
    });
    await tick();
    const age = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'age');
    if (!age) throw new Error('age was not registered');
    await registry.execute(
      { action: 'stage', identity: age.identity, value: 42 },
      { source: 'agent' },
    );
    const revision = registry.get(age.identity)?.state.staged?.revision;

    await view.rerender({
      interactionRegistry: registry,
      ageLabel: 'Maximum age',
    });
    await waitFor(() =>
      expect(registry.get(age.identity)?.metadata.label).toBe('Maximum age'),
    );
    expect(registry.get(age.identity)?.state.staged).toMatchObject({
      value: 42,
      revision,
    });
    expect(
      await screen.findByRole('textbox', {
        name: 'Edit proposed value for Maximum age',
      }),
    ).toHaveValue('42');

    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          { action: 'apply', identity: age.identity, revision },
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(age.identity)?.state.value).toBe(42);

    await view.rerender({
      interactionRegistry: registry,
      ageLabel: 'Preferred age',
    });
    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          { action: 'undo', identity: age.identity },
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(age.identity)?.state.value).toBeNull();
  });

  it('preserves state for subject-label replacements but not subject moves', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    const view = render(FormWithFields, {
      props: {
        interactionRegistry: registry,
        showAge: false,
        formSubject: { type: 'person', id: 'person-1', label: 'Old label' },
      },
    });
    await tick();
    const original = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'fullname');
    if (!original) throw new Error('fullname was not registered');
    await registry.execute(
      { action: 'stage', identity: original.identity, value: 'Grace' },
      { source: 'agent' },
    );
    const revision = registry.get(original.identity)?.state.staged?.revision;

    await view.rerender({
      interactionRegistry: registry,
      showAge: false,
      formSubject: { type: 'person', id: 'person-1', label: 'New label' },
    });
    await waitFor(() =>
      expect(registry.get(original.identity)?.identity.subject?.label).toBe(
        'New label',
      ),
    );
    const replacement = registry.get(original.identity);
    expect(replacement?.state.staged).toMatchObject({
      value: 'Grace',
      revision,
    });
    const fullname = screen.getByRole('textbox', { name: 'Full name' });
    expect(fullname).toHaveAttribute('data-smrt-subject-type', 'person');
    expect(fullname).toHaveAttribute('data-smrt-subject-id', 'person-1');

    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          {
            action: 'apply',
            identity: replacement?.identity ?? original.identity,
            revision,
          },
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          {
            action: 'undo',
            identity: replacement?.identity ?? original.identity,
          },
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(original.identity)?.state.value).toBe('');

    await view.rerender({
      interactionRegistry: registry,
      showAge: false,
      formSubject: { type: 'person', id: 'person-2', label: 'Moved' },
    });
    await waitFor(() =>
      expect(registry.get(original.identity)).toBeUndefined(),
    );
    expect(
      registry.get({
        formId: original.identity.formId,
        controlId: 'fullname',
        subject: { type: 'person', id: 'person-2' },
      })?.state.staged,
    ).toBeUndefined();
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
      dispatchLocalGesture((event) =>
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
          event,
        ),
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

  it('rejects invalid scalar date and phone proposals', async () => {
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
    render(FormWithFields, {
      props: {
        webmcp: true,
        showAge: false,
        showScalarFields: true,
        interactionRegistry: registry,
      },
    });
    await tick();
    await tick();

    expect(
      await registered.at(-1)?.execute({
        appointment: '2026-02-30',
        phone: '21234567890',
      }),
    ).toBe('Staged 2 changes for review');
    for (const controlId of ['appointment', 'phone']) {
      const snapshot = registry
        .list()
        .find((item) => item.identity.controlId === controlId);
      expect(snapshot?.state.staged?.valid).toBe(false);
      expect(
        await dispatchLocalGesture((event) =>
          executeLocalControlBatch(
            registry,
            [
              {
                action: 'apply',
                identity: snapshot?.identity ?? { formId: '', controlId: '' },
                revision: snapshot?.state.staged?.revision,
              },
            ],
            event,
          ),
        ),
      ).toMatchObject({ ok: false });
    }
  });

  it('stages the final appended textarea value before applying it once', async () => {
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
    render(FormWithFields, {
      props: {
        webmcp: true,
        showAge: false,
        showScalarFields: true,
        notesValue: 'Existing',
        notesAppendMode: true,
        interactionRegistry: registry,
      },
    });
    await tick();
    await tick();

    expect(await registered.at(-1)?.execute({ notes: 'Proposed' })).toBe(
      'Staged 1 change for review',
    );
    const notes = registry
      .list()
      .find((item) => item.identity.controlId === 'notes');
    expect(notes?.state.staged?.value).toBe('Existing\nProposed');
    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [
            {
              action: 'apply',
              identity: notes?.identity ?? { formId: '', controlId: '' },
              revision: notes?.state.staged?.revision,
            },
          ],
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(
      registry.get(notes?.identity ?? { formId: '', controlId: '' })?.state
        .value,
    ).toBe('Existing\nProposed');
  });

  it('prepares appended textarea proposals after an async policy wait', async () => {
    const registered: Array<{
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    let releasePolicy: (() => void) | undefined;
    let policyStarted: (() => void) | undefined;
    const policyBlocked = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const policyStartedPromise = new Promise<void>((resolve) => {
      policyStarted = resolve;
    });
    const policyValues: unknown[] = [];
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
      policy: async (command) => {
        if (command.action === 'stage') {
          policyValues.push(command.value);
          if (policyValues.length === 1) {
            policyStarted?.();
            await policyBlocked;
          }
          if (String(command.value).includes('Forbidden')) {
            return { allowed: false, reason: 'forbidden_content' };
          }
        }
        return { allowed: true };
      },
    });
    render(FormWithFields, {
      props: {
        webmcp: true,
        showAge: false,
        showScalarFields: true,
        notesValue: 'Existing',
        notesAppendMode: true,
        interactionRegistry: registry,
      },
    });
    await tick();
    await tick();

    const staging = registered.at(-1)?.execute({ notes: 'Proposed' });
    await policyStartedPromise;
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Notes' }),
      ' human',
    );
    releasePolicy?.();
    expect(await staging).toBe('Staged 1 change for review');
    const notes = registry
      .list()
      .find((item) => item.identity.controlId === 'notes');
    expect(notes?.state.staged).toMatchObject({
      value: 'Existing human\nProposed',
      stale: false,
    });
    expect(policyValues).toEqual([
      'Existing\nProposed',
      'Existing human\nProposed',
    ]);

    expect(await registered.at(-1)?.execute({ notes: 'Forbidden' })).toBe(
      'Staged 0 changes for review; 1 rejected',
    );
    expect(policyValues.at(-1)).toBe('Existing human\nForbidden');
    expect(
      registry.list().find((item) => item.identity.controlId === 'notes')?.state
        .staged?.value,
    ).toBe('Existing human\nProposed');
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
      await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [{ action: 'apply', identity, revision }],
          event,
        ),
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
      await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
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
          event,
        ),
      ),
    ).toMatchObject({
      ok: true,
      results: [{ ok: true }, { ok: true }],
    });
  });

  it('clears rich checkbox and select fields to their explicit empty values', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(FormWithFields, {
      props: {
        interactionRegistry: registry,
        showAge: false,
        showClearFields: true,
        checkboxValue: true,
        selectValue: 'second',
      },
    });
    await tick();
    const enabled = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'enabled');
    const choice = registry
      .list()
      .find((snapshot) => snapshot.identity.controlId === 'choice');
    if (!enabled || !choice)
      throw new Error('clear fields were not registered');

    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [
            {
              action: 'clear',
              identity: enabled.identity,
            },
            {
              action: 'clear',
              identity: choice.identity,
            },
          ],
          event,
        ),
      ),
    ).toMatchObject({
      ok: true,
      results: [{ ok: true }, { ok: true }],
    });
    expect(registry.get(enabled.identity)?.state.value).toBe(false);
    expect(registry.get(choice.identity)?.state.value).toBe('');
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
      return dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [
            {
              action: 'apply',
              identity,
              revision: registry.get(identity)?.state.staged?.revision,
            },
          ],
          event,
        ),
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
    const fullname = screen.getByRole('textbox', { name: 'Full name' });
    expect(fullname).toHaveAttribute('data-smrt-subject-type', 'person');
    expect(fullname).toHaveAttribute('data-smrt-subject-id', 'person-1');
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
    expect(fullname).toHaveAttribute('data-smrt-subject-id', 'person-2');
    expect(await screen.findByText(/person:person-2/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Mutate subject' }),
    );
    await tick();
    expect(await registered.at(-1)?.execute({ fullname: 'Katherine' })).toBe(
      'Staged 1 change for review',
    );
    expect(fullname).toHaveAttribute('data-smrt-subject-id', 'person-mutated');
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
      await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [
            {
              action: 'apply',
              identity: budget?.identity ?? { formId: '', controlId: '' },
              revision: budget?.state.staged?.revision,
            },
          ],
          event,
        ),
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
    expect(
      (
        schema.properties.address as {
          properties: Record<string, Record<string, unknown>>;
        }
      ).properties.country.enum,
    ).toEqual(['CA', 'US']);
    expect(
      (
        schema.properties.address as {
          properties: Record<string, Record<string, unknown>>;
        }
      ).properties.province.enum,
    ).toEqual(
      expect.arrayContaining(['AB', 'BC', 'ON', 'QC', 'US-CA', 'US-NY']),
    );

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

  it('keeps address option schemas and validation live across rerenders', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const addressChanged = vi.fn();
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    const view = render(FormWithStructuredFields, {
      props: {
        webmcp: true,
        structuredRequired: false,
        addressFields: ['province', 'country'],
        addressCountries: [{ value: 'CA', label: 'Canada' }],
        addressProvinces: [{ value: 'AB', label: 'Alberta' }],
        interactionRegistry: registry,
        onaddresschange: addressChanged,
      },
    });
    await tick();
    await tick();

    const addressProperties = () => {
      const tool = registered.at(-1);
      if (!tool) throw new Error('WebMCP tool was not registered');
      return (
        tool.inputSchema as {
          properties: {
            address: { properties: Record<string, Record<string, unknown>> };
          };
        }
      ).properties.address.properties;
    };
    expect(addressProperties()).toEqual({
      province: { type: 'string', enum: ['', 'AB'] },
      country: { type: 'string', enum: ['CA'] },
    });
    await registered.at(-1)?.execute({
      address: { province: 'AB', country: 'CA' },
    });
    const identity = { formId: 'structured-fields', controlId: 'address' };
    expect(registry.get(identity)?.state.staged).toMatchObject({ valid: true });

    await view.rerender({
      webmcp: true,
      structuredRequired: false,
      addressFields: ['province', 'country'],
      addressCountries: [{ value: 'FR', label: 'France' }],
      addressProvinces: [{ value: 'IDF', label: 'Île-de-France' }],
      interactionRegistry: registry,
      onaddresschange: addressChanged,
    });
    await tick();
    await tick();
    expect(addressProperties()).toEqual({
      province: { type: 'string', enum: ['', 'IDF'] },
      country: { type: 'string', enum: ['FR'] },
    });

    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          {
            action: 'apply',
            identity,
            revision: registry.get(identity)?.state.staged?.revision,
          },
          event,
        ),
      ),
    ).toMatchObject({ ok: false });
    expect(addressChanged).not.toHaveBeenCalled();

    await registered.at(-1)?.execute({
      address: { province: 'IDF', country: 'FR' },
    });
    expect(registry.get(identity)?.state.staged).toMatchObject({ valid: true });
    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          {
            action: 'apply',
            identity,
            revision: registry.get(identity)?.state.staged?.revision,
          },
          event,
        ),
      ),
    ).toMatchObject({ ok: true });
    expect(addressChanged).toHaveBeenLastCalledWith({
      province: 'IDF',
      country: 'FR',
    });

    await registered.at(-1)?.execute({
      address: { province: 'XX', country: 'FR' },
    });
    expect(registry.get(identity)?.state.staged).toMatchObject({
      valid: false,
    });
  });

  it('omits zero-based multipleOf when measurement steps use a minimum offset', async () => {
    const registered: Array<{
      inputSchema: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<string>;
    }> = [];
    const registry = createControlInteractionRegistry();
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const view = render(FormWithStructuredFields, {
      props: {
        webmcp: true,
        structuredRequired: false,
        measurementMin: 1,
        measurementStep: 2,
        interactionRegistry: registry,
      },
    });
    await tick();
    await tick();

    const valueSchema = () => {
      const tool = registered.at(-1);
      if (!tool) throw new Error('WebMCP tool was not registered');
      return (
        tool.inputSchema as {
          properties: {
            measurement: { properties: { value: Record<string, unknown> } };
          };
        }
      ).properties.measurement.properties.value;
    };
    expect(valueSchema()).toMatchObject({ type: 'number', minimum: 1 });
    expect(valueSchema()).not.toHaveProperty('multipleOf');

    expect(
      await registered.at(-1)?.execute({
        measurement: { value: 3, unit: 'ft' },
      }),
    ).toBe('Staged 1 change for review');
    const measurement = registry.get({
      formId: 'structured-fields',
      controlId: 'measurement',
    });
    expect(measurement?.state.staged).toMatchObject({ valid: true });

    await registered.at(-1)?.execute({
      measurement: { value: 2, unit: 'ft' },
    });
    expect(
      registry.get({
        formId: 'structured-fields',
        controlId: 'measurement',
      })?.state.staged,
    ).toMatchObject({ valid: false });

    await view.rerender({
      webmcp: true,
      structuredRequired: false,
      measurementMin: 2,
      measurementStep: 2,
      interactionRegistry: registry,
    });
    await tick();
    await tick();
    expect(valueSchema()).toMatchObject({
      type: 'number',
      minimum: 2,
      multipleOf: 2,
    });
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
    const baseRegistry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
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
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue(
        'Ada',
      ),
    );
    expect(legacyRegistry.list()[0]?.state.staged).toBeUndefined();
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
    expect(
      (
        schema.properties.address as {
          properties: Record<string, Record<string, unknown>>;
        }
      ).properties.country.enum,
    ).toEqual(['CA', 'US']);

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
    const registry = createControlInteractionRegistry();
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
        measurementLabel: 'Height',
        measurementMin: 0,
        measurementMax: 10,
        interactionRegistry: registry,
      },
    });
    await tick();
    await tick();

    await view.rerender({
      webmcp: true,
      addressFields: ['country'],
      measurementUnits: ['ft'],
      measurementLabel: 'Weight',
      measurementMin: 100,
      measurementMax: 200,
      interactionRegistry: registry,
    });
    await tick();
    await tick();

    const schema = registered.at(-1)?.inputSchema as {
      properties: Record<
        string,
        {
          title?: string;
          description?: string;
          properties: Record<
            string,
            { enum?: string[]; minimum?: number; maximum?: number }
          >;
        }
      >;
    };
    expect(schema.properties.address.properties).toEqual({
      country: { type: 'string', enum: ['CA', 'US'] },
    });
    expect(schema.properties.measurement.properties.unit.enum).toEqual(['ft']);
    expect(schema.properties.measurement).toMatchObject({
      title: 'Weight',
      description: expect.stringContaining('between 100 and 200'),
    });
    expect(schema.properties.measurement.properties.value).toMatchObject({
      minimum: 100,
      maximum: 200,
    });
    expect(
      registry
        .list('structured-fields')
        .find((snapshot) => snapshot.identity.controlId === 'measurement')
        ?.metadata,
    ).toMatchObject({
      label: 'Weight',
      description: expect.stringContaining('between 100 and 200'),
    });
  });

  it('updates ordinary rich-field schemas after prop changes', async () => {
    const registered: Array<{ inputSchema: Record<string, unknown> }> = [];
    document.modelContext = {
      registerTool(tool) {
        registered.push(tool as (typeof registered)[number]);
      },
    };
    const view = render(FormWithFields, {
      props: {
        webmcp: true,
        ageLabel: 'Minimum age',
        ageMax: 65,
        textRequired: false,
      },
    });
    await tick();
    await tick();

    await view.rerender({
      webmcp: true,
      ageLabel: 'Maximum age',
      ageMax: 100,
      textRequired: true,
    });
    await tick();
    await tick();

    const schema = registered.at(-1)?.inputSchema as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toContain('fullname');
    expect(schema.properties.age).toMatchObject({
      title: 'Maximum age',
      maximum: 100,
      description: expect.stringContaining('maximum 100'),
    });
  });

  it('tightens live field policy without re-registering the field', async () => {
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
    const view = render(FormWithPolicyField, {
      props: { webmcp: true, interactionRegistry: registry },
    });
    await tick();
    await tick();
    expect(await registered.at(-1)?.execute({ policy: 'Grace' })).toBe(
      'Staged 1 change for review',
    );
    const revision = registry.get({
      formId: 'policy-form',
      controlId: 'policy',
    })?.state.staged?.revision;
    expect(revision).toBeDefined();

    await view.rerender({
      webmcp: true,
      interactionRegistry: registry,
      sensitivity: 'secret',
      writable: false,
    });
    await tick();
    await tick();

    expect(registered.at(-1)?.inputSchema).toMatchObject({ properties: {} });
    const snapshot = registry.get({
      formId: 'policy-form',
      controlId: 'policy',
    });
    expect(snapshot?.metadata).toMatchObject({
      sensitivity: 'secret',
      writable: false,
    });
    expect(snapshot?.state).toMatchObject({
      value: undefined,
      valueRedacted: true,
    });
    expect(snapshot?.state).not.toHaveProperty('staged');
    expect(snapshot?.state).not.toHaveProperty('stagedValue');
    expect(
      screen.queryByRole('region', { name: 'Review proposed changes' }),
    ).not.toBeInTheDocument();
    await expect(
      dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          {
            action: 'discard',
            identity: { formId: 'policy-form', controlId: 'policy' },
            revision,
          },
          event,
        ),
      ),
    ).resolves.toMatchObject({ ok: true, action: 'discard' });

    await view.rerender({
      webmcp: true,
      interactionRegistry: registry,
      sensitivity: 'public',
      writable: true,
    });
    await tick();
    await tick();
    expect(
      registry.get({ formId: 'policy-form', controlId: 'policy' })?.state,
    ).not.toHaveProperty('staged');
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
    const applied = await dispatchLocalGesture((event) =>
      executeLocalControlBatch(registry, staged, event),
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
