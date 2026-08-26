import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import { createControlInteractionRegistry } from '../control-interaction.js';
import Fixture from './staged-review.fixture.svelte';

const identity = { formId: 'profile', controlId: 'display-name' };
const createReviewRegistry = () =>
  createControlInteractionRegistry({ isLocalGesture: () => true });

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
    await expectNoA11yViolations(container);
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
