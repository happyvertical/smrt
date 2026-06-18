/**
 * Component test for CheckboxInput (Sweep S11, #1416).
 *
 * Follows the golden pattern (src/components/ui/__tests__/Button.test.ts).
 * CheckboxInput calls `useAppState` (throws outside a <Provider>), so we mock it
 * to a stub default mode. Its form-context lookup uses `getContext` and safely
 * returns undefined outside a provider, so no further stubbing is needed.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));

import CheckboxInput from '../CheckboxInput.svelte';

describe('CheckboxInput', () => {
  it('renders a checkbox labelled by its label, wired via for/id', () => {
    render(CheckboxInput, { props: { name: 'terms', label: 'Accept terms' } });
    const checkbox = screen.getByRole('checkbox', { name: 'Accept terms' });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute('id', 'terms');
    expect(checkbox).not.toBeChecked();
  });

  it('reflects the checked prop', () => {
    render(CheckboxInput, {
      props: { name: 'terms', label: 'Accept terms', checked: true },
    });
    expect(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    ).toBeChecked();
  });

  it('reflects the disabled prop', () => {
    render(CheckboxInput, {
      props: { name: 'terms', label: 'Accept terms', disabled: true },
    });
    expect(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    ).toBeDisabled();
  });

  it('reflects the required prop (and marks the label with *)', () => {
    render(CheckboxInput, {
      props: { name: 'terms', label: 'Accept terms', required: true },
    });
    // Required appends a "*" to the visible label, so the accessible name is "Accept terms*".
    expect(
      screen.getByRole('checkbox', { name: 'Accept terms*' }),
    ).toBeRequired();
  });

  it('toggles checked and fires onchange when clicked', async () => {
    const onchange = vi.fn();
    render(CheckboxInput, {
      props: { name: 'terms', label: 'Accept terms', onchange },
    });
    const checkbox = screen.getByRole('checkbox', { name: 'Accept terms' });
    await userEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(onchange).toHaveBeenCalledWith(true);
    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(onchange).toHaveBeenLastCalledWith(false);
  });

  it('toggles when its label text is clicked', async () => {
    const onchange = vi.fn();
    render(CheckboxInput, {
      props: { name: 'terms', label: 'Accept terms', onchange },
    });
    await userEvent.click(screen.getByText('Accept terms'));
    expect(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    ).toBeChecked();
    expect(onchange).toHaveBeenCalledWith(true);
  });

  it('does not fire onchange when disabled', async () => {
    const onchange = vi.fn();
    render(CheckboxInput, {
      props: { name: 'terms', label: 'Accept terms', disabled: true, onchange },
    });
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Accept terms' }),
    );
    expect(onchange).not.toHaveBeenCalled();
  });

  it('is axe-clean with a label', async () => {
    const { container } = render(CheckboxInput, {
      props: { name: 'newsletter', label: 'Subscribe to the newsletter' },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean when checked, required, and disabled', async () => {
    const { container } = render(CheckboxInput, {
      props: {
        name: 'newsletter',
        label: 'Subscribe to the newsletter',
        checked: true,
        required: true,
        disabled: true,
      },
    });
    await expectNoA11yViolations(container);
  });
});
