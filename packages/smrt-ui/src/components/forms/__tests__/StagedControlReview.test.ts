import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import { createControlInteractionRegistry } from '../control-interaction.js';
import Fixture from './staged-review.fixture.svelte';

const identity = { formId: 'profile', controlId: 'display-name' };

describe('StagedControlReview', () => {
  it('shows an adjacent indicator and applies an edited proposal only after a human click', async () => {
    const registry = createControlInteractionRegistry();
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
    const registry = createControlInteractionRegistry();
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

  it('keeps an invalid proposal staged with accessible validation feedback', async () => {
    const registry = createControlInteractionRegistry();
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
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue(
      'Ada',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard valid changes' }),
    );
    expect(registry.get(identity)?.state.staged).toBeDefined();
  });

  it('rejects secret staging and discards proposals on form reset and unmount', async () => {
    const registry = createControlInteractionRegistry();
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
