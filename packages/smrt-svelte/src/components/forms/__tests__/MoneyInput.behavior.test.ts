/**
 * Behavior tests for MoneyInput (Sweep S11, #1416).
 *
 * Exercises the cents<->display formatting, parsing, currency symbol/code,
 * negative/decimal handling, blur reformatting, and min/max range validation
 * — the logic the shallow a11y suite never touches. The hooks throw outside a
 * <Provider>, so useAppState is mocked to non-smrt ('default') mode.
 */

import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useAppState.svelte.js', () => ({
  useAppState: () => ({ state: { mode: 'default' }, setMode: vi.fn() }),
}));

import MoneyInput from '../MoneyInput.svelte';

describe('MoneyInput — behavior', () => {
  it('renders an existing cents value as a 2-decimal dollar string', () => {
    render(MoneyInput, {
      props: { name: 'price', label: 'Price', value: 15000 },
    });
    expect(screen.getByLabelText('Price')).toHaveValue('150.00');
  });

  it('typing dollars emits the parsed value in cents via onchange', async () => {
    const onchange = vi.fn();
    render(MoneyInput, { props: { name: 'price', label: 'Price', onchange } });
    const input = screen.getByLabelText('Price');
    await userEvent.type(input, '12.34');
    expect(onchange).toHaveBeenLastCalledWith(1234);
  });

  it('strips $ and comma noise when parsing', async () => {
    const onchange = vi.fn();
    render(MoneyInput, { props: { name: 'price', label: 'Price', onchange } });
    await userEvent.type(screen.getByLabelText('Price'), '$1,200');
    expect(onchange).toHaveBeenLastCalledWith(120000);
  });

  it('clearing the input emits null', async () => {
    const onchange = vi.fn();
    render(MoneyInput, {
      props: { name: 'price', label: 'Price', value: 5000, onchange },
    });
    const input = screen.getByLabelText('Price');
    await userEvent.clear(input);
    expect(onchange).toHaveBeenLastCalledWith(null);
  });

  it('reformats the display to 2 decimals on blur', async () => {
    render(MoneyInput, { props: { name: 'price', label: 'Price' } });
    const input = screen.getByLabelText('Price');
    await userEvent.type(input, '5');
    expect(input).toHaveValue('5'); // not reformatted while focused
    await userEvent.tab();
    expect(input).toHaveValue('5.00'); // reformatted on blur
  });

  it('shows CA$ symbol and CAD code by default', () => {
    const { container } = render(MoneyInput, {
      props: { name: 'price', label: 'Price' },
    });
    expect(container.querySelector('.currency-symbol')?.textContent).toBe(
      'CA$',
    );
    expect(container.querySelector('.currency-code')?.textContent).toBe('CAD');
  });

  it('shows US$ symbol and USD code when currency=USD', () => {
    const { container } = render(MoneyInput, {
      props: { name: 'price', label: 'Price', currency: 'USD' },
    });
    expect(container.querySelector('.currency-symbol')?.textContent).toBe(
      'US$',
    );
    expect(container.querySelector('.currency-code')?.textContent).toBe('USD');
  });

  it('writes the cents value into the hidden submission input', async () => {
    const { container } = render(MoneyInput, {
      props: { name: 'price', label: 'Price' },
    });
    await userEvent.type(screen.getByLabelText('Price'), '7.50');
    const hidden = container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="price_cents"]',
    );
    expect(hidden).toHaveValue('750');
  });

  it('flags below-min as invalid with a linked error message', () => {
    render(MoneyInput, {
      props: { name: 'price', label: 'Price', min: 10000, value: 5000 },
    });
    const input = screen.getByLabelText('Price');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'price-error');
    const err = document.getElementById('price-error');
    expect(err).toHaveAttribute('role', 'alert');
    // CA$ symbol + 2-decimal min ($100.00)
    expect(err?.textContent).toContain('CA$100.00');
  });

  it('flags above-max as invalid', () => {
    render(MoneyInput, {
      props: { name: 'price', label: 'Price', max: 10000, value: 20000 },
    });
    const input = screen.getByLabelText('Price');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById('price-error')?.textContent).toContain(
      'CA$100.00',
    );
  });

  it('treats an in-range value as valid (no error)', () => {
    render(MoneyInput, {
      props: {
        name: 'price',
        label: 'Price',
        min: 0,
        max: 100000,
        value: 5000,
      },
    });
    const input = screen.getByLabelText('Price');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(document.getElementById('price-error')).toBeNull();
  });

  it('renders an explicit error prop over range checks', () => {
    render(MoneyInput, {
      props: { name: 'price', label: 'Price', error: 'Required' },
    });
    const err = document.getElementById('price-error');
    expect(err).toHaveTextContent('Required');
    expect(err).toHaveAttribute('role', 'alert');
  });

  it('is axe-clean in a labelled + error state', async () => {
    const { container } = render(MoneyInput, {
      props: { name: 'price', label: 'Price', error: 'Required', value: 1000 },
    });
    await expectNoA11yViolations(container);
  });
});
