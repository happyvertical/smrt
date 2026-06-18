/**
 * Behavior tests for MeasurementInput (Sweep S11, #1416).
 *
 * Exercises numeric value parsing, the unit <select>, real unit conversion on
 * unit change, the emitted MeasurementValue shape, and min/max validation. The
 * hooks throw outside a <Provider>, so useAppState is mocked to 'default' mode.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));

import MeasurementInput from '../MeasurementInput.svelte';

describe('MeasurementInput — behavior', () => {
  it('typing a number emits { value, unit } via onchange', async () => {
    const onchange = vi.fn();
    render(MeasurementInput, {
      props: { name: 'len', label: 'Length', onchange },
    });
    await userEvent.type(screen.getByLabelText('Length'), '12');
    expect(onchange).toHaveBeenLastCalledWith({ value: 12, unit: 'ft' });
  });

  it('clearing the value emits null', async () => {
    const onchange = vi.fn();
    render(MeasurementInput, {
      props: { name: 'len', label: 'Length', value: 5, onchange },
    });
    await userEvent.clear(screen.getByLabelText('Length'));
    expect(onchange).toHaveBeenLastCalledWith(null);
  });

  it('renders the available units as <option>s with abbreviation + label', () => {
    render(MeasurementInput, {
      props: { name: 'len', label: 'Length', units: ['ft', 'm'] },
    });
    const select = screen.getByLabelText('Length unit');
    const options = Array.from(
      select.querySelectorAll('option'),
    ) as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(['ft', 'm']);
    expect(options[0].textContent).toContain('ft (Feet)');
    expect(options[1].textContent).toContain('m (Meters)');
  });

  it('changing the unit converts the value to the new unit', async () => {
    const onchange = vi.fn();
    render(MeasurementInput, {
      props: {
        name: 'len',
        label: 'Length',
        value: 1,
        unit: 'ft',
        units: ['ft', 'in'],
        onchange,
      },
    });
    // 1 ft -> 12 in (rounded to 4 decimals)
    await userEvent.selectOptions(screen.getByLabelText('Length unit'), 'in');
    expect(onchange).toHaveBeenLastCalledWith({ value: 12, unit: 'in' });
  });

  it('1 m converts to 100 cm on unit change', async () => {
    const onchange = vi.fn();
    render(MeasurementInput, {
      props: {
        name: 'len',
        label: 'Length',
        value: 1,
        unit: 'm',
        units: ['m', 'cm'],
        onchange,
      },
    });
    await userEvent.selectOptions(screen.getByLabelText('Length unit'), 'cm');
    expect(onchange).toHaveBeenLastCalledWith({ value: 100, unit: 'cm' });
  });

  it('changing the unit with no value just switches the unit (no onchange)', async () => {
    const onchange = vi.fn();
    render(MeasurementInput, {
      props: {
        name: 'len',
        label: 'Length',
        units: ['ft', 'm'],
        onchange,
      },
    });
    await userEvent.selectOptions(screen.getByLabelText('Length unit'), 'm');
    expect(onchange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Length unit')).toHaveValue('m');
  });

  it('writes a combined "value unit" string into the hidden input', async () => {
    const { container } = render(MeasurementInput, {
      props: { name: 'len', label: 'Length', units: ['ft'] },
    });
    await userEvent.type(screen.getByLabelText('Length'), '3');
    const hidden = container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="len_combined"]',
    );
    expect(hidden).toHaveValue('3 ft');
  });

  it('flags below-min with a linked error citing the unit abbreviation', () => {
    render(MeasurementInput, {
      props: { name: 'len', label: 'Length', min: 10, value: 5, unit: 'ft' },
    });
    const input = screen.getByLabelText('Length');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'len-error');
    const err = document.getElementById('len-error');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err?.textContent).toContain('10');
    expect(err?.textContent).toContain('ft');
  });

  it('flags above-max as invalid', () => {
    render(MeasurementInput, {
      props: { name: 'len', label: 'Length', max: 10, value: 50, unit: 'm' },
    });
    expect(screen.getByLabelText('Length')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(document.getElementById('len-error')?.textContent).toContain('10');
  });

  it('an in-range value is valid (no error)', () => {
    render(MeasurementInput, {
      props: { name: 'len', label: 'Length', min: 0, max: 100, value: 5 },
    });
    const input = screen.getByLabelText('Length');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(document.getElementById('len-error')).toBeNull();
  });

  it('is axe-clean in a labelled + error state', async () => {
    const { container } = render(MeasurementInput, {
      props: { name: 'len', label: 'Length', error: 'Required', value: 5 },
    });
    await expectNoA11yViolations(container);
  });
});
