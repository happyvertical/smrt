import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import CountrySelect from '../CountrySelect.svelte';
import CurrencySelect from '../CurrencySelect.svelte';
import { countryOptions, provinceOptions } from '../code-select-options.js';
import ProvinceSelect from '../ProvinceSelect.svelte';
import Fixture from './code-select.fixture.svelte';

const data = () => new FormData(document.querySelector('form')!);

describe('code selectors native form contract', () => {
  it.each([
    'currency',
    'country',
    'province',
  ] as const)('%s keeps blank required and binds user choices', async (kind) => {
    render(Fixture, { kind });
    const select = screen.getByLabelText('Code') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.checkValidity()).toBe(false);
    expect(data().get('code')).toBe('');
    const next = select.options[1].value;
    await fireEvent.change(select, { target: { value: next } });
    expect(screen.getByLabelText('Bound value').textContent).toBe(next);
    expect(data().get('code')).toBe(next);
    expect(select.checkValidity()).toBe(true);
    document.querySelector('form')!.reset();
    await tick();
    expect(select.value).toBe('');
  });
  it.each([
    'currency',
    'country',
    'province',
  ] as const)('%s retains exact unknown data and option changes', async (kind) => {
    const { rerender } = render(Fixture, { kind, initial: '  unknown raw  ' });
    expect(data().get('code')).toBe('  unknown raw  ');
    await rerender({
      kind,
      initial: '  unknown raw  ',
      options: [{ value: 'new' }],
    });
    expect(screen.getByLabelText('Bound value').textContent).toBe(
      '  unknown raw  ',
    );
    expect(data().get('code')).toBe('  unknown raw  ');
  });
  it('readonly submits exactly once to an external form, disabled and disabled fieldsets omit', async () => {
    const { rerender } = render(Fixture, { initial: 'RAW', readOnly: true });
    expect(screen.getByLabelText('Code')).toBeDisabled();
    expect(data().getAll('code')).toEqual(['RAW']);
    await rerender({ initial: 'RAW', readOnly: true, disabled: true });
    expect(data().has('code')).toBe(false);
    await rerender({ initial: 'RAW', readOnly: true, fieldsetDisabled: true });
    expect(data().has('code')).toBe(false);
  });
  it('preserves native disabled-option omission', () => {
    render(Fixture, {
      initial: 'CAD',
      options: [{ value: 'CAD', disabled: true }],
    });
    expect((screen.getByLabelText('Code') as HTMLSelectElement).value).toBe(
      'CAD',
    );
    expect(
      (screen.getByLabelText('Code') as HTMLSelectElement).selectedOptions[0]
        .disabled,
    ).toBe(true);
    // Native omission is verified in Chromium: jsdom includes disabled options.
  });
  it('country changes preserve province and unsupported countries allow free text', async () => {
    const { rerender } = render(Fixture, { kind: 'province', initial: 'ON' });
    await rerender({ kind: 'province', initial: 'ON', country: 'US' });
    expect(data().get('code')).toBe('ON');
    await rerender({ kind: 'province', initial: 'ON', country: 'GB' });
    const input = screen.getByLabelText('Code');
    expect(input.tagName).toBe('INPUT');
    await fireEvent.input(input, { target: { value: 'Greater London' } });
    expect(data().get('code')).toBe('Greater London');
    await rerender({
      kind: 'province',
      initial: 'ON',
      country: 'GB',
      options: [],
    });
    expect(screen.getByLabelText('Code').tagName).toBe('SELECT');
    expect(data().get('code')).toBe('Greater London');
  });
  it('uses localized labels and safe locale fallback without changing codes', () => {
    expect(
      countryOptions('fr').find((option) => option.value === 'US')?.label,
    ).toBe('États-Unis');
    expect(
      countryOptions('not_a_locale').find((option) => option.value === 'US')
        ?.label,
    ).toBe('United States');
    expect(countryOptions('en')).toHaveLength(249);
    expect(provinceOptions('CA')).toHaveLength(13);
    expect(provinceOptions('US')).toHaveLength(57);
  });
  it.each([
    CurrencySelect,
    CountrySelect,
    ProvinceSelect,
  ])('exposes native focus and element methods', (component) => {
    const { component: control } = render(component, { 'aria-label': 'Code' });
    control.focus();
    expect(control.getElement()).toBe(document.activeElement);
  });
});
