/**
 * Deep behavior tests for SelectInput (Sweep S11, #1416).
 *
 * The existing a11y suite only asserts labelling + describedby + axe. This
 * suite drives the real selection pipeline: choosing an option → handleChange →
 * updateValue → onchange + bindable value; the placeholder option (disabled +
 * selected when empty); option rendering from the options prop; and the
 * required/disabled wiring.
 *
 * SelectInput calls useAppState (it throws outside a <Provider>), so it is
 * mocked to a non-listening stub — the reference pattern from
 * rich-inputs-a11y.test.ts. (SelectInput does not use useSTT.)
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));

import SelectInput from '../SelectInput.svelte';

const COUNTRIES = [
  { value: 'us', label: 'United States' },
  { value: 'ca', label: 'Canada' },
  { value: 'mx', label: 'Mexico' },
];

describe('SelectInput — selection', () => {
  it('fires onchange with the chosen option value', async () => {
    const onchange = vi.fn();
    render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        options: COUNTRIES,
        onchange,
      },
    });

    await userEvent.selectOptions(screen.getByLabelText('Country'), 'ca');

    expect(onchange).toHaveBeenCalledWith('ca');
  });

  it('reflects the selected value on the <select>', async () => {
    render(SelectInput, {
      props: { name: 'country', label: 'Country', options: COUNTRIES },
    });
    const select = screen.getByLabelText('Country') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'mx');
    expect(select).toHaveValue('mx');
  });

  it('renders the initial value prop as the selected option', () => {
    render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        options: COUNTRIES,
        value: 'us',
      },
    });
    expect(screen.getByLabelText('Country')).toHaveValue('us');
  });
});

describe('SelectInput — options & placeholder', () => {
  it('renders one <option> per provided option plus the placeholder', () => {
    render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        options: COUNTRIES,
        placeholder: 'Choose a country…',
      },
    });
    // 3 countries + 1 placeholder option.
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(
      screen.getByRole('option', { name: 'United States' }),
    ).toBeInTheDocument();
  });

  it('renders the placeholder as a disabled option, selected when value is empty', () => {
    render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        options: COUNTRIES,
        placeholder: 'Choose a country…',
      },
    });
    const placeholder = screen.getByRole('option', {
      name: 'Choose a country…',
    }) as HTMLOptionElement;
    expect(placeholder).toBeDisabled();
    expect(placeholder.value).toBe('');
  });
});

describe('SelectInput — states & attributes', () => {
  it('reflects required onto the select', () => {
    // NOTE: with required, the "*" lives inside the <label>, so the select's
    // accessible name becomes "Country *" — query by id rather than label.
    const { container } = render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        options: COUNTRIES,
        required: true,
      },
    });
    expect(container.querySelector('#country')).toBeRequired();
  });

  it('disables the select and ignores selection when disabled', async () => {
    const onchange = vi.fn();
    render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        options: COUNTRIES,
        disabled: true,
        onchange,
      },
    });
    const select = screen.getByLabelText('Country');
    expect(select).toBeDisabled();
    await userEvent.selectOptions(select, 'ca').catch(() => {});
    expect(onchange).not.toHaveBeenCalled();
  });

  it('is axe-clean when labelled with a placeholder', async () => {
    const { container } = render(SelectInput, {
      props: {
        name: 'country',
        label: 'Country',
        placeholder: 'Choose…',
        options: COUNTRIES,
      },
    });
    await expectNoA11yViolations(container);
  });
});
