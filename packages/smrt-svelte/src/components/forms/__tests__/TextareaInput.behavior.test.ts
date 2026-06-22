/**
 * Deep behavior tests for TextareaInput (Sweep S11, #1416).
 *
 * The existing a11y suite only asserts labelling + describedby + axe. This
 * suite drives the real value pipeline: typing → handleInput → updateValue →
 * onchange + bindable value, plus the rows/required/disabled wiring and the
 * focus-gated placeholder.
 *
 * TextareaInput calls useAppState/useSTT (they throw outside a <Provider>), so
 * both are mocked to non-listening stubs — the reference pattern from
 * rich-inputs-a11y.test.ts.
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

import TextareaInput from '../TextareaInput.svelte';

describe('TextareaInput — typing & value', () => {
  it('fires onchange with the current value as the user types', async () => {
    const onchange = vi.fn();
    render(TextareaInput, { props: { name: 'bio', label: 'Bio', onchange } });

    await userEvent.type(screen.getByLabelText('Bio'), 'Hello');

    expect(onchange).toHaveBeenLastCalledWith('Hello');
  });

  it('renders the initial value prop', () => {
    render(TextareaInput, {
      props: { name: 'bio', label: 'Bio', value: 'Seeded text' },
    });
    expect(screen.getByLabelText('Bio')).toHaveValue('Seeded text');
  });

  it('captures multi-line input', async () => {
    render(TextareaInput, { props: { name: 'bio', label: 'Bio' } });
    const textarea = screen.getByLabelText('Bio');
    await userEvent.type(textarea, 'line one{enter}line two');
    expect(textarea).toHaveValue('line one\nline two');
  });
});

describe('TextareaInput — states & attributes', () => {
  it('forwards the rows prop onto the textarea', () => {
    render(TextareaInput, { props: { name: 'bio', label: 'Bio', rows: 8 } });
    expect(screen.getByLabelText('Bio')).toHaveAttribute('rows', '8');
  });

  it('defaults to 4 rows when not specified', () => {
    render(TextareaInput, { props: { name: 'bio', label: 'Bio' } });
    expect(screen.getByLabelText('Bio')).toHaveAttribute('rows', '4');
  });

  it('reflects required onto the textarea', () => {
    // NOTE: with required, the "*" lives inside the <label>, so the textarea's
    // accessible name becomes "Bio *" — query by id rather than label.
    const { container } = render(TextareaInput, {
      props: { name: 'bio', label: 'Bio', required: true },
    });
    expect(container.querySelector('#bio')).toBeRequired();
  });

  it('disables the textarea and ignores typing when disabled', async () => {
    const onchange = vi.fn();
    render(TextareaInput, {
      props: { name: 'bio', label: 'Bio', disabled: true, onchange },
    });
    const textarea = screen.getByLabelText('Bio');
    expect(textarea).toBeDisabled();
    await userEvent.type(textarea, 'ignored');
    expect(onchange).not.toHaveBeenCalled();
  });

  it('reveals the placeholder only while focused', async () => {
    render(TextareaInput, {
      props: { name: 'bio', label: 'Bio', placeholder: 'Tell us about you' },
    });
    const textarea = screen.getByLabelText('Bio');
    expect(textarea).toHaveAttribute('placeholder', '');
    await userEvent.click(textarea);
    expect(textarea).toHaveAttribute('placeholder', 'Tell us about you');
  });

  it('is axe-clean when labelled', async () => {
    const { container } = render(TextareaInput, {
      props: { name: 'bio', label: 'Bio' },
    });
    await expectNoA11yViolations(container);
  });
});
