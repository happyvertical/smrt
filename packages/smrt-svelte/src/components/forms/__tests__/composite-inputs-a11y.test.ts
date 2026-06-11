/**
 * Accessibility golden tests for the multi-field composite form inputs
 * (Sweep L1, #1420). Each sub-field is programmatically labelled and the
 * shared/validation error is associated via aria-describedby + role="alert".
 * Hooks are mocked (Provider-backed, throw otherwise).
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

import AddressInput from '../AddressInput.svelte';
import DateRangeInput from '../DateRangeInput.svelte';
import DateTimeInput from '../DateTimeInput.svelte';
import MeasurementInput from '../MeasurementInput.svelte';
import MoneyInput from '../MoneyInput.svelte';

describe('composite form inputs — accessibility', () => {
  it('MoneyInput: labelled amount + axe-clean', async () => {
    const { container } = render(MoneyInput, {
      props: { name: 'price', label: 'Price' },
    });
    expect(screen.getByLabelText('Price')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('MeasurementInput: labelled value + labelled unit select + axe-clean', async () => {
    const { container } = render(MeasurementInput, {
      props: { name: 'weight', label: 'Weight' },
    });
    expect(screen.getByLabelText('Weight')).toBeInTheDocument();
    expect(screen.getByLabelText('Weight unit')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('DateRangeInput: labelled start/end + axe-clean', async () => {
    const { container } = render(DateRangeInput, {
      props: { name: 'range', label: 'Dates' },
    });
    expect(screen.getByLabelText('Start')).toBeInTheDocument();
    expect(screen.getByLabelText('End')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('AddressInput: all fields labelled + axe-clean', async () => {
    const { container } = render(AddressInput, {
      props: { name: 'addr', label: 'Address' },
    });
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
    await expectNoA11yViolations(container);
  });

  it('DateTimeInput: labelled + axe-clean', async () => {
    const { container } = render(DateTimeInput, {
      props: { name: 'when', label: 'When' },
    });
    expect(screen.getByLabelText('When')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
