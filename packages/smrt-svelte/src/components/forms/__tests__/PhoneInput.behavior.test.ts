/**
 * Behavior tests for PhoneInput (Sweep S11, #1416).
 *
 * Exercises the progressive digit-masking formatter (parens/space/dash, the
 * +1 country-code branch), normalized emission via onchange, and the
 * 10–11 digit validity check. The hooks throw outside a <Provider>, so
 * useAppState (default mode) + useSTT (non-listening stub) are mocked.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));
vi.mock('../../../hooks/useSTT.svelte.js', () => ({
  useSTT: () => ({
    isListening: false,
    isInitializing: false,
    isReady: false,
    adapterType: null,
    downloadProgress: 0,
    lastResult: '',
    initialize: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import PhoneInput from '../PhoneInput.svelte';

describe('PhoneInput — behavior', () => {
  it('masks digits progressively as the user types a 10-digit number', async () => {
    render(PhoneInput, { props: { name: 'phone', label: 'Phone' } });
    const input = screen.getByLabelText('Phone') as HTMLInputElement;
    await userEvent.type(input, '5551234567');
    expect(input).toHaveValue('(555) 123-4567');
  });

  it('formats a partial number with an open paren', async () => {
    render(PhoneInput, { props: { name: 'phone', label: 'Phone' } });
    const input = screen.getByLabelText('Phone') as HTMLInputElement;
    await userEvent.type(input, '55');
    expect(input).toHaveValue('(55');
  });

  it('emits the formatted (normalized) value via onchange', async () => {
    const onchange = vi.fn();
    render(PhoneInput, { props: { name: 'phone', label: 'Phone', onchange } });
    await userEvent.type(screen.getByLabelText('Phone'), '5551234567');
    expect(onchange).toHaveBeenLastCalledWith('(555) 123-4567');
  });

  it('strips non-digit noise from pasted input', async () => {
    render(PhoneInput, { props: { name: 'phone', label: 'Phone' } });
    const input = screen.getByLabelText('Phone') as HTMLInputElement;
    await userEvent.click(input);
    await userEvent.paste('555-123-4567');
    expect(input).toHaveValue('(555) 123-4567');
  });

  it('formats an 11-digit number starting with 1 as +1 (...)', async () => {
    render(PhoneInput, { props: { name: 'phone', label: 'Phone' } });
    const input = screen.getByLabelText('Phone') as HTMLInputElement;
    await userEvent.click(input);
    await userEvent.paste('15551234567');
    expect(input).toHaveValue('+1 (555) 123-4567');
  });

  it('flags an incomplete number as invalid with a linked alert', () => {
    render(PhoneInput, {
      props: { name: 'phone', label: 'Phone', value: '(555) 12' },
    });
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'phone-error');
    const err = document.getElementById('phone-error');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err).toHaveTextContent('Invalid phone number');
  });

  it('treats a complete 10-digit number as valid (no error)', () => {
    render(PhoneInput, {
      props: { name: 'phone', label: 'Phone', value: '(555) 123-4567' },
    });
    const input = screen.getByLabelText('Phone');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(document.getElementById('phone-error')).toBeNull();
  });

  it('treats an empty value as valid (not invalid)', () => {
    render(PhoneInput, { props: { name: 'phone', label: 'Phone', value: '' } });
    expect(screen.getByLabelText('Phone')).not.toHaveAttribute('aria-invalid');
  });

  it('uses a tel input type', () => {
    render(PhoneInput, { props: { name: 'phone', label: 'Phone' } });
    expect(screen.getByLabelText('Phone')).toHaveAttribute('type', 'tel');
  });

  it('is axe-clean in a labelled invalid state', async () => {
    const { container } = render(PhoneInput, {
      props: { name: 'phone', label: 'Phone', value: '(555) 12' },
    });
    await expectNoA11yViolations(container);
  });
});
