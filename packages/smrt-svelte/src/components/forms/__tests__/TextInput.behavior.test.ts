/**
 * Deep behavior tests for TextInput (Sweep S11, #1416).
 *
 * The existing a11y suite only asserts labelling + describedby + axe. This
 * suite exercises the real value pipeline: typing → handleInput → updateValue →
 * onchange + bindable value, the email-validation derived state (aria-invalid,
 * the invalid-email supporting message), disabled/required wiring, and the
 * placeholder-on-focus behavior.
 *
 * TextInput calls useAppState/useSTT (they throw outside a <Provider>), so both
 * are mocked to non-listening stubs — the reference pattern from
 * rich-inputs-a11y.test.ts.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';

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

import TextInput from '../TextInput.svelte';

describe('TextInput — typing & value', () => {
  it('fires onchange with the current value on each keystroke', async () => {
    const onchange = vi.fn();
    render(TextInput, {
      props: { name: 'fullname', label: 'Full name', onchange },
    });

    await userEvent.type(screen.getByLabelText('Full name'), 'Ada');

    expect(onchange).toHaveBeenLastCalledWith('Ada');
  });

  it('renders the initial value prop into the input', () => {
    render(TextInput, {
      props: { name: 'fullname', label: 'Full name', value: 'Seed' },
    });
    expect(screen.getByLabelText('Full name')).toHaveValue('Seed');
  });

  it('updates the input value as the user types', async () => {
    render(TextInput, { props: { name: 'fullname', label: 'Full name' } });
    const input = screen.getByLabelText('Full name');
    await userEvent.type(input, 'Lovelace');
    expect(input).toHaveValue('Lovelace');
  });
});

describe('TextInput — email validation', () => {
  it('marks aria-invalid when an email value is malformed', () => {
    render(TextInput, {
      props: {
        name: 'email',
        label: 'Email',
        type: 'email',
        value: 'not-an-email',
      },
    });
    expect(screen.getByLabelText('Email')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('shows the invalid-email supporting message for a bad address', () => {
    render(TextInput, {
      props: { name: 'email', label: 'Email', type: 'email', value: 'nope' },
    });
    expect(screen.getByText('Invalid email address')).toBeInTheDocument();
  });

  it('is valid (no aria-invalid) for a well-formed email', () => {
    render(TextInput, {
      props: {
        name: 'email',
        label: 'Email',
        type: 'email',
        value: 'ada@example.com',
      },
    });
    expect(screen.getByLabelText('Email')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('treats an empty email as valid (no error until the user types)', () => {
    render(TextInput, {
      props: { name: 'email', label: 'Email', type: 'email' },
    });
    expect(screen.getByLabelText('Email')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});

describe('TextInput — states & attributes', () => {
  it('reflects required onto the input', () => {
    // NOTE: with required, the "*" lives inside the <label>, so the input's
    // accessible name becomes "Full name *" — query by id rather than label.
    const { container } = render(TextInput, {
      props: { name: 'fullname', label: 'Full name', required: true },
    });
    expect(container.querySelector('#fullname')).toBeRequired();
  });

  it('disables the input and ignores typing when disabled', async () => {
    const onchange = vi.fn();
    render(TextInput, {
      props: { name: 'fullname', label: 'Full name', disabled: true, onchange },
    });
    const input = screen.getByLabelText('Full name');
    expect(input).toBeDisabled();
    await userEvent.type(input, 'ignored');
    expect(onchange).not.toHaveBeenCalled();
  });

  it('reveals the placeholder only while focused', async () => {
    render(TextInput, {
      props: {
        name: 'fullname',
        label: 'Full name',
        placeholder: 'Enter name',
      },
    });
    const input = screen.getByLabelText('Full name');
    expect(input).toHaveAttribute('placeholder', '');
    await userEvent.click(input);
    expect(input).toHaveAttribute('placeholder', 'Enter name');
  });

  it('is axe-clean when labelled', async () => {
    const { container } = render(TextInput, {
      props: { name: 'fullname', label: 'Full name' },
    });
    await expectNoA11yViolations(container);
  });
});
