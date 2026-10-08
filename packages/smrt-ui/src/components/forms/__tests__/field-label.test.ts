import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y.js';
import Combobox from '../Combobox.svelte';
import CurrencySelect from '../CurrencySelect.svelte';
import FieldLabel from '../FieldLabel.svelte';
import ProvinceSelect from '../ProvinceSelect.svelte';

describe('FieldLabel', () => {
  it('renders a label bound to its control with a hidden required marker', () => {
    const { container } = render(FieldLabel, {
      props: { label: 'Amount', for: 'amt', id: 'amt-l', required: true },
    });
    const label = container.querySelector('label');
    expect(label?.getAttribute('for')).toBe('amt');
    expect(label?.classList.contains('smrt-field-label')).toBe(true);
    expect(label?.querySelector('[aria-hidden="true"]')?.textContent).toBe('*');
  });

  it('renders a non-label element for read-only displays', () => {
    const { container } = render(FieldLabel, { props: { label: 'Total' } });
    expect(container.querySelector('label')).toBeNull();
    expect(container.querySelector('span.smrt-field-label')?.textContent).toBe(
      'Total',
    );
  });
});

describe('code selects with a label', () => {
  it('CurrencySelect takes its accessible name from the label', async () => {
    const { container } = render(CurrencySelect, {
      props: { label: 'Currency', required: true, value: 'USD' },
    });
    const select = screen.getByRole('combobox', { name: 'Currency' });
    const labelId = select.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toContain(
      'Currency',
    );
    expect(container.querySelector('label')?.getAttribute('for')).toBe(
      select.id,
    );
    expect((select as HTMLSelectElement).required).toBe(true);
    await expectNoA11yViolations(container);
  });

  it('keeps a caller id as the control id', () => {
    render(CurrencySelect, { props: { label: 'Currency', id: 'cur' } });
    expect(screen.getByRole('combobox', { name: 'Currency' }).id).toBe('cur');
  });

  it('ProvinceSelect free-text fallback is labelled too', () => {
    render(ProvinceSelect, { props: { label: 'Region', country: 'ZZ' } });
    expect(screen.getByRole('textbox', { name: 'Region' })).toBeTruthy();
  });

  it('Combobox shares the field label class', () => {
    const { container } = render(Combobox, {
      props: { label: 'Customer', name: 'c', options: [] },
    });
    expect(
      container.querySelector('label')?.classList.contains('smrt-field-label'),
    ).toBe(true);
  });
});
