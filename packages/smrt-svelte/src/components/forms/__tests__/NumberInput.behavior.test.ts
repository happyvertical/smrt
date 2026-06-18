/**
 * Deep behavior tests for NumberInput (Sweep S11, #1416).
 *
 * The existing a11y suite covers labelling + a single out-of-range case. This
 * suite drives the real numeric pipeline: typing → handleInput (parseFloat /
 * empty→null) → onchange + bindable value; the min/max derived range-validation
 * (aria-invalid, the linked role=alert error, its at-least/at-most message
 * variants); and the step/required/disabled attribute wiring.
 *
 * NumberInput calls useAppState (it throws outside a <Provider>), so it is
 * mocked to a non-listening stub — the reference pattern from
 * rich-inputs-a11y.test.ts. (NumberInput does not use useSTT.)
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));

import NumberInput from '../NumberInput.svelte';

describe('NumberInput — typing & parsing', () => {
  it('fires onchange with the parsed number as the user types', async () => {
    const onchange = vi.fn();
    render(NumberInput, { props: { name: 'age', label: 'Age', onchange } });

    await userEvent.type(screen.getByLabelText('Age'), '42');

    expect(onchange).toHaveBeenLastCalledWith(42);
  });

  it('parses a decimal value', async () => {
    const onchange = vi.fn();
    render(NumberInput, {
      props: { name: 'weight', label: 'Weight', step: 0.1, onchange },
    });
    await userEvent.type(screen.getByLabelText('Weight'), '3.5');
    expect(onchange).toHaveBeenLastCalledWith(3.5);
  });

  it('emits null when the field is cleared back to empty', async () => {
    const onchange = vi.fn();
    render(NumberInput, {
      props: { name: 'age', label: 'Age', value: 7, onchange },
    });
    const input = screen.getByLabelText('Age');
    await userEvent.clear(input);
    expect(onchange).toHaveBeenLastCalledWith(null);
  });

  it('renders the initial numeric value', () => {
    render(NumberInput, { props: { name: 'age', label: 'Age', value: 99 } });
    expect(screen.getByLabelText('Age')).toHaveValue(99);
  });

  it('renders an empty string for a null value', () => {
    render(NumberInput, { props: { name: 'age', label: 'Age', value: null } });
    expect(screen.getByLabelText('Age')).toHaveValue(null);
  });
});

describe('NumberInput — range validation', () => {
  it('flags aria-invalid and shows the at-most message above max', () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', max: 10, value: 99 },
    });
    const input = screen.getByLabelText('Age');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'age-error');
    const error = document.getElementById('age-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('Value must be at most 10');
  });

  it('flags aria-invalid and shows the at-least message below min', () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', min: 18, value: 5 },
    });
    const input = screen.getByLabelText('Age');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById('age-error')).toHaveTextContent(
      'Value must be at least 18',
    );
  });

  it('is valid for a value inside the range', () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', min: 0, max: 120, value: 30 },
    });
    const input = screen.getByLabelText('Age');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById('age-error')).toBeNull();
  });

  it('treats a boundary value (== max) as valid', () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', max: 10, value: 10 },
    });
    expect(screen.getByLabelText('Age')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('treats a null value as valid even with a range', () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', min: 1, max: 5, value: null },
    });
    expect(screen.getByLabelText('Age')).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('clears the invalid state once the user types an in-range value', async () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', max: 10, value: 99 },
    });
    const input = screen.getByLabelText('Age');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
  });
});

describe('NumberInput — attributes', () => {
  it('forwards min, max, and step onto the input', () => {
    render(NumberInput, {
      props: { name: 'age', label: 'Age', min: 1, max: 100, step: 5 },
    });
    const input = screen.getByLabelText('Age');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '100');
    expect(input).toHaveAttribute('step', '5');
  });

  it('reflects required and disabled', async () => {
    const onchange = vi.fn();
    // NOTE: with required, the "*" lives inside the <label>, so the input's
    // accessible name becomes "Age *" — query by id rather than label.
    const { container } = render(NumberInput, {
      props: {
        name: 'age',
        label: 'Age',
        required: true,
        disabled: true,
        onchange,
      },
    });
    const input = container.querySelector('#age') as HTMLInputElement;
    expect(input).toBeRequired();
    expect(input).toBeDisabled();
    await userEvent.type(input, '5');
    expect(onchange).not.toHaveBeenCalled();
  });

  it('is axe-clean when labelled', async () => {
    const { container } = render(NumberInput, {
      props: { name: 'age', label: 'Age' },
    });
    await expectNoA11yViolations(container);
  });
});
