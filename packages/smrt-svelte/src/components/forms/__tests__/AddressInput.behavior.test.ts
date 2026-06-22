/**
 * Behavior tests for AddressInput (Sweep S11, #1416).
 *
 * Exercises the sub-field wiring: typing/selecting each field composes a
 * Partial<AddressValue> emitted via onchange, the `fields` prop gates which
 * sub-fields render (and thus which keys appear in the composed value),
 * province/country selects populate from options, and the error prop marks
 * every field invalid with a single linked alert. useAppState (default mode)
 * is mocked since the hook throws outside a <Provider>.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));

import AddressInput from '../AddressInput.svelte';

describe('AddressInput — behavior', () => {
  it('typing the street composes a value including the street', async () => {
    const onchange = vi.fn();
    render(AddressInput, {
      props: { name: 'addr', label: 'Address', onchange },
    });
    await userEvent.type(
      screen.getByLabelText('Street Address'),
      '123 Main St',
    );
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ street: '123 Main St' }),
    );
  });

  it('typing the city updates the composed value', async () => {
    const onchange = vi.fn();
    render(AddressInput, {
      props: { name: 'addr', label: 'Address', onchange },
    });
    await userEvent.type(screen.getByLabelText('City'), 'Toronto');
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ city: 'Toronto' }),
    );
  });

  it('selecting a province emits its value code', async () => {
    const onchange = vi.fn();
    render(AddressInput, {
      props: { name: 'addr', label: 'Address', onchange },
    });
    await userEvent.selectOptions(
      screen.getByLabelText('Province/State'),
      'ON',
    );
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ province: 'ON' }),
    );
  });

  it('selecting a country emits its value code', async () => {
    const onchange = vi.fn();
    render(AddressInput, {
      props: { name: 'addr', label: 'Address', onchange },
    });
    await userEvent.selectOptions(screen.getByLabelText('Country'), 'US');
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ country: 'US' }),
    );
  });

  it('defaults the country to CA', () => {
    render(AddressInput, { props: { name: 'addr', label: 'Address' } });
    expect(screen.getByLabelText('Country')).toHaveValue('CA');
  });

  it('composes a complete address object across all fields', async () => {
    const onchange = vi.fn();
    render(AddressInput, {
      props: { name: 'addr', label: 'Address', onchange },
    });
    await userEvent.type(screen.getByLabelText('Postal/ZIP Code'), 'M5V 2T6');
    expect(onchange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        street: '',
        city: '',
        province: '',
        postalCode: 'M5V 2T6',
        country: 'CA',
      }),
    );
  });

  it('only emits keys for the fields it was told to render', async () => {
    const onchange = vi.fn();
    render(AddressInput, {
      props: {
        name: 'addr',
        label: 'Address',
        fields: ['city', 'country'],
        onchange,
      },
    });
    expect(screen.queryByLabelText('Street Address')).toBeNull();
    expect(screen.queryByLabelText('Postal/ZIP Code')).toBeNull();
    await userEvent.type(screen.getByLabelText('City'), 'Ottawa');
    const composed = onchange.mock.calls.at(-1)?.[0];
    expect(Object.keys(composed).sort()).toEqual(['city', 'country']);
    expect(composed.city).toBe('Ottawa');
  });

  it('seeds sub-fields from the bound value object', () => {
    render(AddressInput, {
      props: {
        name: 'addr',
        label: 'Address',
        value: { city: 'Calgary', province: 'AB', country: 'CA' },
      },
    });
    expect(screen.getByLabelText('City')).toHaveValue('Calgary');
    expect(screen.getByLabelText('Province/State')).toHaveValue('AB');
  });

  it('renders the province and country option sets', () => {
    render(AddressInput, { props: { name: 'addr', label: 'Address' } });
    const provinces = screen.getByLabelText('Province/State');
    expect(provinces.querySelector('option[value="QC"]')?.textContent).toBe(
      'Quebec',
    );
    const countries = screen.getByLabelText('Country');
    expect(countries.querySelector('option[value="US"]')?.textContent).toBe(
      'United States',
    );
  });

  it('marks every field invalid and links one alert when error is set', () => {
    render(AddressInput, {
      props: { name: 'addr', label: 'Address', error: 'Address required' },
    });
    const street = screen.getByLabelText('Street Address');
    expect(street).toHaveAttribute('aria-invalid', 'true');
    expect(street).toHaveAttribute('aria-describedby', 'addr-error');
    const err = document.getElementById('addr-error');
    expect(err).toHaveTextContent('Address required');
    expect(err).toHaveAttribute('role', 'alert');
  });

  it('is axe-clean with all fields labelled', async () => {
    const { container } = render(AddressInput, {
      props: { name: 'addr', label: 'Address' },
    });
    await expectNoA11yViolations(container);
  });
});
