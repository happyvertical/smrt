/**
 * Component test for Toggle (Sweep S11, #1416).
 *
 * Follows the golden pattern (src/components/ui/__tests__/Button.test.ts):
 * render → assert role/name/state → drive with user-event → prove axe-clean.
 * Toggle renders native checkbox semantics, so it surfaces as a `checkbox` role.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Toggle from '../Toggle.svelte';

describe('Toggle', () => {
  it('renders a checkbox with its label as the accessible name', () => {
    render(Toggle, { props: { label: 'Email notifications' } });
    const toggle = screen.getByRole('checkbox', {
      name: 'Email notifications',
    });
    expect(toggle).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
  });

  it('prefers ariaLabel over label for the accessible name', () => {
    render(Toggle, { props: { label: 'Visible', ariaLabel: 'Wifi' } });
    expect(screen.getByRole('checkbox', { name: 'Wifi' })).toBeInTheDocument();
  });

  it('reflects the checked prop', () => {
    render(Toggle, { props: { ariaLabel: 'Active', checked: true } });
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeChecked();
  });

  it('reflects the disabled prop', () => {
    render(Toggle, { props: { ariaLabel: 'Active', disabled: true } });
    expect(screen.getByRole('checkbox', { name: 'Active' })).toBeDisabled();
  });

  it('forwards name, value, and id to the input for form submission', () => {
    render(Toggle, {
      props: { ariaLabel: 'Sub', name: 'sub', value: 'on', id: 'sub-toggle' },
    });
    const toggle = screen.getByRole('checkbox', {
      name: 'Sub',
    }) as HTMLInputElement;
    expect(toggle).toHaveAttribute('name', 'sub');
    expect(toggle).toHaveAttribute('id', 'sub-toggle');
    // Svelte binds `value` as the DOM property on checkboxes (not a reflected attribute).
    expect(toggle.value).toBe('on');
  });

  it('toggles checked and fires onchange when clicked', async () => {
    const onchange = vi.fn();
    render(Toggle, { props: { ariaLabel: 'Active', onchange } });
    const toggle = screen.getByRole('checkbox', { name: 'Active' });
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(onchange).toHaveBeenCalledWith(true);
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(onchange).toHaveBeenLastCalledWith(false);
  });

  it('is keyboard-activatable with Space when focused', async () => {
    const onchange = vi.fn();
    render(Toggle, { props: { ariaLabel: 'Active', onchange } });
    const toggle = screen.getByRole('checkbox', { name: 'Active' });
    toggle.focus();
    expect(toggle).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(toggle).toBeChecked();
    expect(onchange).toHaveBeenCalledWith(true);
  });

  it('does not fire onchange when disabled', async () => {
    const onchange = vi.fn();
    render(Toggle, {
      props: { ariaLabel: 'Active', disabled: true, onchange },
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Active' }));
    expect(onchange).not.toHaveBeenCalled();
  });

  it('is axe-clean with a label', async () => {
    const { container } = render(Toggle, {
      props: { label: 'Accessible toggle' },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean in the checked + disabled state', async () => {
    const { container } = render(Toggle, {
      props: { label: 'Locked on', checked: true, disabled: true },
    });
    await expectNoA11yViolations(container);
  });
});
