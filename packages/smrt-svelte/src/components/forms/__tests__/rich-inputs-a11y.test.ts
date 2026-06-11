/**
 * Accessibility golden tests for the standalone rich form inputs (Sweep L1,
 * #1420). These inputs carry their own <label> + supporting/error text (they do
 * NOT compose the base primitives), so each was given aria-describedby →
 * supporting text and aria-invalid on its error state.
 *
 * They depend on the Provider-backed useAppState/useSTT hooks (which throw
 * outside a <Provider>), so both are mocked once here to non-listening stubs.
 */
import { render, screen } from '@testing-library/svelte';
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

import NumberInput from '../NumberInput.svelte';
import PhoneInput from '../PhoneInput.svelte';
import SelectInput from '../SelectInput.svelte';
import TextareaInput from '../TextareaInput.svelte';
import TextInput from '../TextInput.svelte';

describe('rich form inputs — accessibility', () => {
  it('TextInput: labelled + describedby + axe-clean', async () => {
    const { container } = render(TextInput, {
      props: { name: 'fullname', label: 'Full name' },
    });
    const input = screen.getByLabelText('Full name');
    expect(input).toHaveAttribute('aria-describedby', 'fullname-supporting');
    await expectNoA11yViolations(container);
  });

  it('TextareaInput: labelled + describedby + axe-clean', async () => {
    const { container } = render(TextareaInput, {
      props: { name: 'bio', label: 'Bio' },
    });
    const input = screen.getByLabelText('Bio');
    expect(input).toHaveAttribute('aria-describedby', 'bio-supporting');
    await expectNoA11yViolations(container);
  });

  it('SelectInput: labelled + describedby + axe-clean', async () => {
    const { container } = render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        placeholder: 'Choose…',
        options: [{ value: 'us', label: 'United States' }],
      },
    });
    const select = screen.getByLabelText('Country');
    expect(select).toHaveAttribute('aria-describedby', 'country-supporting');
    await expectNoA11yViolations(container);
  });

  it('PhoneInput: labelled + axe-clean', async () => {
    const { container } = render(PhoneInput, {
      props: { name: 'phone', label: 'Phone' },
    });
    expect(screen.getByLabelText('Phone')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('NumberInput: labelled + axe-clean', async () => {
    const { container } = render(NumberInput, {
      props: { name: 'age', label: 'Age' },
    });
    expect(screen.getByLabelText('Age')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('NumberInput: sets aria-invalid + links the error when out of range', () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', max: 10, value: 99 },
    });
    const input = screen.getByLabelText('Age');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'age-error');
    expect(document.getElementById('age-error')).toHaveAttribute(
      'role',
      'alert',
    );
  });
});
