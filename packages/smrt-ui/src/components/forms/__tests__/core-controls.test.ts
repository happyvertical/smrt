import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Progress from '../../feedback/Progress.svelte';
import Spinner from '../../feedback/Spinner.svelte';
import { createControlInteractionRegistry } from '../control-interaction.js';
import ErrorSummary from '../ErrorSummary.svelte';
import Fixture from './core-controls.fixture.svelte';

describe('core controls', () => {
  it('provides distinct checkbox, switch, radio, slider, range, and segmented semantics', async () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    );
    expect(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    ).toBeChecked();

    await userEvent.click(
      screen.getByRole('switch', { name: 'Notifications' }),
    );
    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeChecked();

    await userEvent.click(screen.getByRole('radio', { name: 'Viewer' }));
    expect(screen.getByRole('radio', { name: 'Viewer' })).toBeChecked();

    expect(screen.getAllByRole('slider')).toHaveLength(3);
    await userEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.getByRole('radio', { name: 'List' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('registers all controls and keeps agent staging separate from human apply', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    render(Fixture, { props: { registry } });
    expect(
      registry.list('settings').map((item) => item.identity.controlId),
    ).toEqual(
      expect.arrayContaining([
        'accepted',
        'notifications',
        'role',
        'volume',
        'price',
        'view',
      ]),
    );

    await registry.execute(
      {
        action: 'stage',
        identity: { formId: 'settings', controlId: 'volume' },
        value: 55,
      },
      { source: 'agent' },
    );
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('30');
    await registry.execute(
      {
        action: 'apply',
        identity: { formId: 'settings', controlId: 'volume' },
      },
      { source: 'agent', confirmed: true },
    );
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('30');
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('slider', { name: 'Volume' })).toHaveValue('55');
  });

  it('is axe-clean as a composed form', async () => {
    const registry = createControlInteractionRegistry();
    const { container } = render(Fixture, { props: { registry } });
    await expectNoA11yViolations(container);
  });

  it('focuses the usable control inside an error-summary target', async () => {
    const { container } = render(ErrorSummary, {
      props: {
        errors: [
          {
            controlId: 'profile-photo',
            label: 'Profile photo',
            message: 'Choose a file',
          },
        ],
      },
    });
    const wrapper = document.createElement('div');
    wrapper.dataset.smrtControl = 'profile-photo';
    wrapper.scrollIntoView = () => undefined;
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    const file = document.createElement('input');
    file.type = 'file';
    wrapper.append(hidden, file);
    container.append(wrapper);

    await userEvent.click(
      screen.getByRole('button', { name: 'Profile photo: Choose a file' }),
    );

    expect(file).toHaveFocus();
  });
});

describe('progress feedback', () => {
  it('distinguishes determinate and indeterminate progress', async () => {
    const { rerender } = render(Progress, {
      props: { label: 'Import', value: 40, showValue: true },
    });
    expect(screen.getByRole('progressbar', { name: 'Import' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    await rerender({ label: 'Import', value: undefined });
    expect(
      screen.getByRole('progressbar', { name: 'Import' }),
    ).not.toHaveAttribute('aria-valuenow');
  });

  it('announces a spinner label', () => {
    render(Spinner, { props: { label: 'Saving changes' } });
    expect(screen.getByRole('status')).toHaveTextContent('Saving changes');
  });
});
