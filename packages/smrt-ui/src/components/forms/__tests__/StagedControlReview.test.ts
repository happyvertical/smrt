import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import {
  createControlInteractionRegistry,
  executeLocalControlBatch,
} from '../control-interaction.js';
import SelectFixture from './select-interaction.fixture.svelte';
import Fixture from './staged-review.fixture.svelte';

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
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
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
      name: 'Apply',
    });
    await userEvent.click(applyButtons[0]);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus(),
    );
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
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

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
    await userEvent.click(editor);
    expect(editor).toHaveProperty('checked', applied);
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

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

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

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

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

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
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
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
        'Constraints not satisfied',
      ),
    );
    const field = screen.getByRole('textbox', { name: 'Display name' });
    expect(field).toHaveValue('Ada');
    const proposal = screen.getByRole('textbox', {
      name: 'Edit proposed value for Display name',
    });
    await userEvent.type(proposal, 'Grace');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Ada',
    );
    expect(registry.get(identity)?.state.staged?.value).toBeNull();
  });

  it('keeps subject-qualified identities distinct in the review list', async () => {
    const registry = createReviewRegistry();
    let secondValue = 'Ada';
    registry.register({
      identity: {
        ...identity,
        subject: { type: 'record', id: 'two' },
      },
      metadata: { kind: 'text', label: 'Record two' },
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
    expect(
      screen.getAllByRole('textbox', { name: /Edit proposed value/ }),
    ).toHaveLength(2);
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
