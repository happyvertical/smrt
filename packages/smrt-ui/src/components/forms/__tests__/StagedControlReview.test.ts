import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import {
  createControlInteractionRegistry,
  executeLocalControlBatch,
  executeLocalControlCommand,
} from '../control-interaction.js';
import CompositeUserEditFixture from './composite-user-edit.fixture.svelte';
import SelectFixture from './select-interaction.fixture.svelte';
import Fixture from './staged-review.fixture.svelte';
import FieldsetFixture from './staged-review-fieldset.fixture.svelte';
import OuterFieldsetFixture from './staged-review-outer-fieldset.fixture.svelte';

const identity = { formId: 'profile', controlId: 'display-name' };
const createReviewRegistry = () =>
  createControlInteractionRegistry({ isLocalGesture: () => true });

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

describe('StagedControlReview', () => {
  it('keeps a click-driven composite edit made during a failed async apply', async () => {
    const registry = createReviewRegistry();
    const onchange = vi.fn();
    const modeState: { get?: () => string; set?: (next: string) => void } = {};
    render(CompositeUserEditFixture, {
      props: { registry, onchange, modeState },
    });
    const identity = registry
      .list('profile')
      .find((snapshot) => snapshot.identity.controlId === 'mode')?.identity;
    if (!identity) throw new Error('mode was not registered');

    const value = () => modeState.get?.();
    const setValue = (next: unknown) => modeState.set?.(String(next));
    let releaseSetter: (() => void) | undefined;
    let setterStarted: (() => void) | undefined;
    const setterBlocked = new Promise<void>((resolve) => {
      releaseSetter = resolve;
    });
    const setterStartedPromise = new Promise<void>((resolve) => {
      setterStarted = resolve;
    });
    registry.register({
      identity,
      metadata: { kind: 'segmented-control' },
      getValue: value,
      setValue: async (next) => {
        setValue(next);
        setterStarted?.();
        await setterBlocked;
        throw new Error('setter_failed');
      },
      restoreValue: setValue,
    });
    await registry.execute(
      { action: 'stage', identity, value: 'review' },
      { source: 'agent' },
    );

    const applying = dispatchLocalGesture((event) =>
      executeLocalControlCommand(
        registry,
        { action: 'apply', identity, revision: 1 },
        event,
      ),
    );
    await setterStartedPromise;
    await userEvent.click(screen.getByRole('radio', { name: 'Published' }));
    await waitFor(() => expect(onchange).toHaveBeenCalled());
    releaseSetter?.();

    expect(await applying).toMatchObject({
      ok: false,
      reason: 'setter_failed',
    });
    expect(value()).toBe('published');
  });

  it('shows an adjacent indicator and applies an edited proposal only after a human click', async () => {
    const registry = createReviewRegistry();
    const { container } = render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent', actorId: 'assistant' },
    );

    const field = screen.getByRole('textbox', { name: 'Display name' });
    expect(field).toHaveValue('Ada');
    await waitFor(() =>
      expect(field).toHaveAttribute('data-smrt-staged', 'true'),
    );
    expect(
      screen.getByRole('region', { name: 'Review proposed changes' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Proposed by assistant/)).toBeInTheDocument();
    expect(screen.getByText('profile/display-name')).toBeInTheDocument();

    const proposal = screen.getByRole('textbox', {
      name: 'Edit proposed value for Display name',
    });
    await userEvent.clear(proposal);
    await userEvent.type(proposal, 'Grace Hopper');
    expect(field).toHaveValue('Ada');
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Display name' }),
    );
    expect(field).toHaveValue('Grace Hopper');
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Review proposed changes' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText('Applied proposed change.', {
        selector: 'p[role="status"]',
      }),
    ).toHaveTextContent('Applied proposed change.');
    expect(field).toHaveFocus();
    await expectNoA11yViolations(container);
  });

  it('keeps Enter in the proposal editor from submitting the form', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const proposal = await screen.findByRole('textbox', {
      name: 'Edit proposed value for Display name',
    });
    const submitted = vi.fn((event: Event) => event.preventDefault());
    screen
      .getByRole('form', { name: 'Profile form' })
      .addEventListener('submit', submitted);
    await userEvent.type(proposal, '{Enter}');

    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Ada',
    );
    expect(registry.get(identity)?.state.staged?.value).toBe('Grace');
    expect(submitted).not.toHaveBeenCalled();
  });

  it('disables apply and restores it when an ancestor fieldset changes state in a base Form', async () => {
    const registry = createReviewRegistry();
    const { container } = render(FieldsetFixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const fieldset = container.querySelector('fieldset');
    if (!(fieldset instanceof HTMLFieldSetElement)) {
      throw new Error('Expected form fieldset');
    }
    fieldset.disabled = true;
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Apply Display name' }),
      ).toBeDisabled(),
    );
    expect(
      screen.getByRole('button', { name: 'Discard Display name' }),
    ).not.toBeDisabled();

    fieldset.disabled = false;
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Apply Display name' }),
      ).not.toBeDisabled(),
    );
  });

  it('refreshes staged state when a fieldset wrapping the form changes state', async () => {
    const registry = createReviewRegistry();
    const { container } = render(OuterFieldsetFixture, {
      props: { registry },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const fieldset = container.querySelector('fieldset');
    if (!(fieldset instanceof HTMLFieldSetElement)) {
      throw new Error('Expected outer form fieldset');
    }
    fieldset.disabled = true;
    await waitFor(() =>
      expect(registry.get(identity)?.state.disabled).toBe(true),
    );
    expect(
      screen.getByRole('button', { name: 'Apply Display name' }),
    ).toBeDisabled();

    fieldset.disabled = false;
    await waitFor(() =>
      expect(registry.get(identity)?.state.disabled).toBe(false),
    );
    expect(
      screen.getByRole('button', { name: 'Apply Display name' }),
    ).not.toBeDisabled();
  });

  it('resets an edited draft when a replacement proposal has a new revision', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    const proposal = await screen.findByRole('textbox', {
      name: 'Edit proposed value for Display name',
    });
    await userEvent.clear(proposal);
    await userEvent.type(proposal, 'Katherine');

    await registry.execute(
      { action: 'stage', identity, value: 'Hopper' },
      { source: 'agent' },
    );

    expect(proposal).toHaveValue('Hopper');
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Display name' }),
    );
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Hopper',
    );
  });

  it('moves focus to the next proposal after applying one', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    let secondValue = 'Ada';
    const secondIdentity = { formId: 'profile', controlId: 'family-name' };
    registry.register({
      identity: secondIdentity,
      metadata: { kind: 'text', label: 'Family name' },
      getValue: () => secondValue,
      setValue: (next) => {
        secondValue = String(next);
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    await registry.execute(
      { action: 'stage', identity: secondIdentity, value: 'Hopper' },
      { source: 'agent' },
    );

    const applyButtons = await screen.findAllByRole('button', {
      name: /^Apply (?!valid changes$)/,
    });
    await userEvent.click(applyButtons[0]);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Apply Family name' }),
      ).toHaveFocus(),
    );
  });

  it('names every proposal action and reports batch failures on their affected fields', async () => {
    const familyIdentity = { formId: 'profile', controlId: 'family-name' };
    const preferencesIdentity = {
      formId: 'profile',
      controlId: 'preferences',
    };
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
      policy: (command) =>
        command.action === 'apply' &&
        command.identity.controlId === familyIdentity.controlId
          ? { allowed: false, reason: 'opaque_policy_code' }
          : { allowed: true },
    });
    let familyName = 'Lovelace';
    let preferences: Record<string, string> = { layout: 'comfortable' };
    render(Fixture, { props: { registry } });
    registry.register({
      identity: familyIdentity,
      metadata: { kind: 'text', label: 'Family name' },
      getValue: () => familyName,
      setValue: (next) => {
        familyName = String(next);
      },
    });
    registry.register({
      identity: preferencesIdentity,
      metadata: { kind: 'custom', label: 'Preferences' },
      getValue: () => preferences,
      setValue: (next) => {
        preferences = next as Record<string, string>;
      },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    await registry.execute(
      { action: 'stage', identity: familyIdentity, value: 'Hopper' },
      { source: 'agent' },
    );
    await registry.execute(
      {
        action: 'stage',
        identity: preferencesIdentity,
        value: { layout: 'compact' },
      },
      { source: 'agent' },
    );

    expect(
      screen.getByRole('button', { name: 'Apply Display name' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Discard Display name' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Apply Family name' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Discard Family name' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Apply Preferences' }),
    ).toBeInTheDocument();

    const preferencesEditor = screen.getByRole('textbox', {
      name: 'Edit proposed value for Preferences',
    });
    await userEvent.clear(preferencesEditor);
    await userEvent.type(preferencesEditor, '"');
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );

    await waitFor(() =>
      expect(
        screen.getByText('Processed 1 of 3 proposed changes.'),
      ).toBeInTheDocument(),
    );
    const familyItem = screen
      .getByText('Family name', {
        selector: 'strong',
      })
      .closest('li');
    const preferencesItem = screen
      .getByText('Preferences', {
        selector: 'strong',
      })
      .closest('li');
    if (!familyItem || !preferencesItem) {
      throw new Error('Expected remaining proposal items');
    }
    expect(within(familyItem).getByRole('alert')).toHaveTextContent(
      'This proposal is not valid.',
    );
    expect(within(preferencesItem).getByRole('alert')).toHaveTextContent(
      'This proposal is not valid.',
    );
    expect(screen.queryByText('opaque_policy_code')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Unexpected end of JSON input'),
    ).not.toBeInTheDocument();
    expect(familyName).toBe('Lovelace');
    expect(preferences).toEqual({ layout: 'comfortable' });
  });

  it('returns focus to the affected control after applying the final batch', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply valid changes' }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('textbox', { name: 'Display name' }),
      ).toHaveFocus(),
    );
  });

  it('returns focus through the registry for a composite control wrapper', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'profile', controlId: 'volume' },
        value: 50,
      },
      { source: 'agent' },
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply valid changes' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'Volume' })).toHaveFocus(),
    );
  });

  it('keeps a nonnumeric optional number proposal invalid and unapplied', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    const numberIdentity = { formId: 'profile', controlId: 'score' };

    expect(
      await registry.execute(
        { action: 'stage', identity: numberIdentity, value: 'abc' },
        { source: 'agent' },
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(numberIdentity)?.state.staged).toMatchObject({
      valid: false,
      validationMessage: 'invalid_number',
    });
    expect(screen.getByRole('spinbutton', { name: 'Score' })).toHaveValue(1);
  });

  it.each([
    {
      controlId: 'birthday',
      proposal: '2025-02-30',
      currentValue: '',
    },
    {
      controlId: 'meeting-time',
      proposal: '25:00',
      currentValue: '',
    },
    {
      controlId: 'intensity',
      proposal: 5,
      currentValue: 50,
    },
  ])('keeps native $controlId proposals invalid when the browser would canonicalize them', async ({
    controlId,
    proposal,
    currentValue,
  }) => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    const nativeIdentity = { formId: 'profile', controlId };

    expect(
      await registry.execute(
        { action: 'stage', identity: nativeIdentity, value: proposal },
        { source: 'agent' },
      ),
    ).toMatchObject({ ok: true });
    expect(registry.get(nativeIdentity)?.state.staged).toMatchObject({
      value: proposal,
      valid: false,
      validationMessage: 'invalid_value',
    });
    expect(registry.get(nativeIdentity)?.state.value).toBe(currentValue);

    expect(
      await dispatchLocalGesture((event) =>
        executeLocalControlCommand(
          registry,
          { action: 'apply', identity: nativeIdentity },
          event,
        ),
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_value' });
    expect(registry.get(nativeIdentity)?.state.value).toBe(currentValue);
  });

  it('does not coerce an emptied numeric draft to zero', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    const numberIdentity = { formId: 'profile', controlId: 'score' };
    await registry.execute(
      { action: 'stage', identity: numberIdentity, value: 5 },
      { source: 'agent' },
    );
    const proposal = await screen.findByRole('textbox', {
      name: 'Edit proposed value for Score',
    });
    await userEvent.clear(proposal);
    await userEvent.click(screen.getByRole('button', { name: 'Apply Score' }));

    expect(screen.getByRole('spinbutton', { name: 'Score' })).toHaveValue(1);
    expect(registry.get(numberIdentity)?.state.staged?.value).toBe(5);
  });

  it.each([
    { staged: true, applied: false },
    { staged: false, applied: true },
  ])('edits a $staged boolean proposal with a native checkbox and applies $applied', async ({
    staged,
    applied,
  }) => {
    let value = staged;
    const booleanIdentity = { formId: 'profile', controlId: 'enabled' };
    const setValue = vi.fn((next: unknown) => {
      value = next as boolean;
    });
    const registry = createReviewRegistry();
    registry.register({
      identity: booleanIdentity,
      metadata: { kind: 'checkbox', label: 'Enabled' },
      getValue: () => value,
      setValue,
    });
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity: booleanIdentity, value: staged },
      { source: 'agent' },
    );

    const editor = await screen.findByRole('checkbox', {
      name: 'Edit proposed value for Enabled',
    });
    expect(editor).toHaveProperty('checked', staged);
    expect(
      screen.queryByRole('textbox', {
        name: 'Edit proposed value for Enabled',
      }),
    ).not.toBeInTheDocument();
    const submitted = vi.fn((event: Event) => event.preventDefault());
    screen
      .getByRole('form', { name: 'Profile form' })
      .addEventListener('submit', submitted);
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    expect(editor.dispatchEvent(enter)).toBe(false);
    expect(enter.defaultPrevented).toBe(true);
    expect(submitted).not.toHaveBeenCalled();
    expect(registry.get(booleanIdentity)?.state.staged?.value).toBe(staged);

    await userEvent.click(editor);
    expect(editor).toHaveProperty('checked', applied);
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Enabled' }),
    );

    expect(setValue).toHaveBeenLastCalledWith(applied);
    expect(value).toBe(applied);
    expect(typeof value).toBe('boolean');
    expect(registry.get(booleanIdentity)?.state.staged).toBeUndefined();
  });

  it('announces stale apply failures with localized review text', async () => {
    let registry!: ReturnType<typeof createControlInteractionRegistry>;
    registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
      policy: (command) => {
        if (command.action === 'apply') {
          registry.recordUserEdit?.(command.identity);
        }
        return { allowed: true };
      },
    });
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Display name' }),
    );

    const status = screen.getByText(
      'The field changed after this proposal was staged.',
      { selector: 'p[role="status"]' },
    );
    expect(status).not.toHaveTextContent('staged_value_stale');
  });

  it('announces gesture failures with localized invalid text', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => false,
    });
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Display name' }),
    );

    const status = screen.getByText('This proposal is not valid.', {
      selector: 'p[role="status"]',
    });
    expect(status).not.toHaveTextContent('local_gesture_required');
  });

  it('announces the pre-batch proposal total', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'profile', controlId: 'score' },
        value: 'abc',
      },
      { source: 'agent' },
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply valid changes' }),
    );

    expect(
      screen.getByText('Processed 1 of 2 proposed changes.'),
    ).toBeInTheDocument();
  });

  it('marks competing user edits stale and lets the human discard them', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    const field = screen.getByRole('textbox', { name: 'Display name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Katherine');
    await waitFor(() =>
      expect(
        screen.getByText('The field changed after this proposal was staged.'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: 'Apply Display name' }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard Display name' }),
    );
    expect(field).toHaveValue('Katherine');
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Review proposed changes' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText('Discarded proposed change.', {
        selector: 'p[role="status"]',
      }),
    ).toHaveTextContent('Discarded proposed change.');
  });

  it('keeps trusted edit tracking when the consumer supplies an input handler', async () => {
    const registry = createReviewRegistry();
    const formOnInput = vi.fn();
    render(Fixture, { props: { registry, formOnInput } });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    const field = screen.getByRole('textbox', { name: 'Display name' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Katherine');

    expect(formOnInput).toHaveBeenCalled();
    await waitFor(() =>
      expect(registry.get(identity)?.state.staged?.stale).toBe(true),
    );
  });

  it('preserves a staged proposal across same-identity metadata updates', async () => {
    const registry = createReviewRegistry();
    const view = render(Fixture, {
      props: { registry, displayNameLabel: 'Display name' },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );

    await view.rerender({
      registry,
      displayNameLabel: 'Preferred name',
    });

    await waitFor(() =>
      expect(registry.get(identity)?.state.staged?.value).toBe('Grace'),
    );
    expect(
      screen.getByRole('textbox', {
        name: 'Edit proposed value for Preferred name',
      }),
    ).toHaveValue('Grace');
  });

  it('preserves undo history across same-identity metadata updates', async () => {
    const registry = createReviewRegistry();
    const view = render(Fixture, {
      props: { registry, displayNameLabel: 'Display name' },
    });
    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
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
    ).toMatchObject({ ok: true });
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Grace',
    );

    await view.rerender({
      registry,
      displayNameLabel: 'Preferred name',
    });
    expect(screen.getByRole('textbox', { name: 'Preferred name' })).toHaveValue(
      'Grace',
    );
    await waitFor(() =>
      expect(registry.get(identity)?.metadata.label).toBe('Preferred name'),
    );

    const undo = await dispatchLocalGesture((event) =>
      executeLocalControlBatch(registry, [{ action: 'undo', identity }], event),
    );
    expect(undo.results[0]).toMatchObject({ ok: true });
    expect(screen.getByRole('textbox', { name: 'Preferred name' })).toHaveValue(
      'Ada',
    );
  });

  it('moves registration when the form registry and identity change', async () => {
    const firstRegistry = createReviewRegistry();
    const secondRegistry = createReviewRegistry();
    const view = render(Fixture, {
      props: { registry: firstRegistry, formId: 'profile' },
    });
    expect(firstRegistry.get(identity)).toBeDefined();

    await view.rerender({ registry: secondRegistry, formId: 'account' });

    await waitFor(() => expect(firstRegistry.get(identity)).toBeUndefined());
    expect(
      secondRegistry.get({ formId: 'account', controlId: 'display-name' }),
    ).toBeDefined();
  });

  it('moves registration when a subject identity mutates in place', async () => {
    const registry = createReviewRegistry();
    const subject = { type: 'record', id: 'one' };
    render(Fixture, { props: { registry, subject } });
    const firstIdentity = { ...identity, subject: { ...subject } };
    expect(registry.get(firstIdentity)).toBeDefined();

    await userEvent.click(
      screen.getByRole('button', { name: 'Mutate subject' }),
    );

    await waitFor(() => expect(registry.get(firstIdentity)).toBeUndefined());
    expect(
      registry.get({
        ...identity,
        subject: { type: 'record', id: 'two' },
      }),
    ).toBeDefined();
  });

  it('rejects disabled and undeclared base-select proposals on apply', async () => {
    const registry = createReviewRegistry();
    render(SelectFixture, { props: { registry } });
    const selectIdentity = { formId: 'account', controlId: 'role' };
    expect(
      registry
        .get(selectIdentity)
        ?.metadata.options?.find((option) => option.value === 'owner'),
    ).toMatchObject({ disabled: true });

    for (const candidate of ['admin', 'owner']) {
      await registry.execute(
        { action: 'stage', identity: selectIdentity, value: candidate },
        { source: 'agent' },
      );
      expect(registry.get(selectIdentity)?.state.staged).toMatchObject({
        value: candidate,
        valid: false,
      });
      const batch = await dispatchLocalGesture((event) =>
        executeLocalControlBatch(
          registry,
          [
            {
              action: 'apply',
              identity: selectIdentity,
              revision: registry.get(selectIdentity)?.state.staged?.revision,
            },
          ],
          event,
        ),
      );
      expect(batch.results[0]).toMatchObject({
        ok: false,
        reason: 'staged_value_invalid',
      });
      expect(screen.getByRole('combobox', { name: 'Role' })).toHaveValue(
        'user',
      );
    }
  });

  it('rejects an enabled empty option when the base select is required', async () => {
    const registry = createReviewRegistry();
    render(SelectFixture, { props: { registry, required: true } });
    const selectIdentity = { formId: 'account', controlId: 'role' };

    await registry.execute(
      { action: 'stage', identity: selectIdentity, value: '' },
      { source: 'agent' },
    );

    expect(registry.get(selectIdentity)?.state.staged).toMatchObject({
      value: '',
      valid: false,
    });
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveValue('user');
  });

  it('lets the human correct an invalid proposal before applying it', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: '' },
      { source: 'agent' },
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This proposal is not valid.',
      ),
    );
    const field = screen.getByRole('textbox', { name: 'Display name' });
    expect(field).toHaveValue('Ada');
    const proposal = screen.getByRole('textbox', {
      name: 'Edit proposed value for Display name',
    });
    await userEvent.type(proposal, 'Grace');
    expect(
      screen.getByRole('button', { name: 'Apply Display name' }),
    ).toBeEnabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Display name' }),
    );
    await waitFor(() => expect(field).toHaveValue('Grace'));
    expect(registry.get(identity)?.state.staged).toBeUndefined();
  });

  it('keeps invalid entries out of valid-only batch actions', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: '' },
      { source: 'agent' },
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard valid changes' }),
    );
    expect(registry.get(identity)?.state.staged).toBeDefined();
  });

  it('does not coerce an unedited null proposal into a string', async () => {
    const registry = createReviewRegistry();
    render(Fixture, { props: { registry } });
    await registry.execute(
      { action: 'stage', identity, value: null },
      { source: 'agent' },
    );

    expect(
      screen.getByRole('textbox', {
        name: 'Edit proposed value for Display name',
      }),
    ).toHaveValue('null');
    await userEvent.click(
      screen.getByRole('button', { name: 'Apply Display name' }),
    );
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Ada',
    );
    expect(registry.get(identity)?.state.staged?.value).toBeNull();
  });

  it('gives same-label subject-qualified proposals unique action names', async () => {
    const registry = createReviewRegistry();
    let secondValue = 'Ada';
    registry.register({
      identity: {
        ...identity,
        subject: { type: 'record', id: 'two' },
      },
      metadata: { kind: 'text', label: 'Display name' },
      getValue: () => secondValue,
      setValue: (next) => {
        secondValue = String(next);
      },
    });
    render(Fixture, {
      props: { registry, subject: { type: 'record', id: 'one' } },
    });
    const renderedFirst = screen.getByRole('textbox', {
      name: 'Display name',
    });
    await registry.execute(
      {
        action: 'stage',
        identity: { ...identity, subject: { type: 'record', id: 'two' } },
        value: 'Katherine',
      },
      { source: 'agent' },
    );
    await waitFor(() =>
      expect(renderedFirst).not.toHaveAttribute('data-smrt-staged'),
    );
    await registry.execute(
      {
        action: 'stage',
        identity: { ...identity, subject: { type: 'record', id: 'one' } },
        value: 'Grace',
      },
      { source: 'agent' },
    );
    await waitFor(() =>
      expect(renderedFirst).toHaveAttribute('data-smrt-staged', 'true'),
    );

    expect(screen.getByText('profile/display-name · record:one')).toBeVisible();
    expect(screen.getByText('profile/display-name · record:two')).toBeVisible();
    for (const subjectId of ['one', 'two']) {
      const actionName = `Display name record:${subjectId} [identity:["profile","display-name","record","${subjectId}"]]`;
      expect(
        screen.getByRole('textbox', {
          name: `Edit proposed value for ${actionName}`,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `Apply ${actionName}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `Discard ${actionName}` }),
      ).toBeInTheDocument();
    }
  });

  it('keeps tagged action identities distinct when human and fallback subjects collide', async () => {
    const registry = createReviewRegistry();
    let secondValue = 'Ada';
    registry.register({
      identity: {
        ...identity,
        subject: { type: 'record', id: 'b' },
      },
      metadata: { kind: 'text', label: 'Display name' },
      getValue: () => secondValue,
      setValue: (next) => {
        secondValue = String(next);
      },
    });
    render(Fixture, {
      props: {
        registry,
        subject: { type: 'record', id: 'a', label: 'record:b' },
      },
    });

    await registry.execute(
      {
        action: 'stage',
        identity: { ...identity, subject: { type: 'record', id: 'b' } },
        value: 'Katherine',
      },
      { source: 'agent' },
    );
    await registry.execute(
      {
        action: 'stage',
        identity: {
          ...identity,
          subject: { type: 'record', id: 'a', label: 'record:b' },
        },
        value: 'Grace',
      },
      { source: 'agent' },
    );

    const first =
      'Display name record:b [identity:["profile","display-name","record","a"]]';
    const second =
      'Display name record:b [identity:["profile","display-name","record","b"]]';
    expect(first).not.toBe(second);
    for (const actionName of [first, second]) {
      expect(
        screen.getByRole('textbox', {
          name: `Edit proposed value for ${actionName}`,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `Apply ${actionName}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `Discard ${actionName}` }),
      ).toBeInTheDocument();
    }
  });

  it('rejects secret staging and discards proposals on form reset and unmount', async () => {
    const registry = createReviewRegistry();
    const rendered = render(Fixture, { props: { registry } });
    const secret = await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'profile', controlId: 'api-token' },
        value: 'replacement',
      },
      { source: 'agent' },
    );
    expect(secret).toMatchObject({ ok: false, reason: 'sensitive_control' });

    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() =>
      expect(registry.get(identity)?.state.staged).toBeUndefined(),
    );

    await registry.execute(
      { action: 'stage', identity, value: 'Grace' },
      { source: 'agent' },
    );
    rendered.unmount();
    expect(registry.get(identity)).toBeUndefined();
  });
});
