/**
 * Component tests for CurrencyDisplay (Sweep S11, #1416).
 *
 * CurrencyDisplay formats a numeric amount (cents or dollars) into a currency
 * string via Intl.NumberFormat('en-CA'). Expected strings are derived with the
 * SAME formatter the component uses so assertions stay locale-robust. Tests
 * assert the real API from CurrencyDisplay.svelte — unit conversion, currency
 * code, sign handling (negative/zero/showSign), highlight classes, size
 * classes, and axe-cleanliness.
 */
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import CurrencyDisplay from '../CurrencyDisplay.svelte';

/** Mirror the component's absolute-value currency formatting. */
function money(absDollars: number, currency: 'CAD' | 'USD' = 'CAD'): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(absDollars);
}

describe('CurrencyDisplay', () => {
  it('formats cents into dollars by default', () => {
    render(CurrencyDisplay, { props: { amount: 12345 } }); // cents → $123.45
    expect(screen.getByText(money(123.45))).toBeInTheDocument();
  });

  it('treats the amount as dollars when unit=dollars', () => {
    render(CurrencyDisplay, { props: { amount: 50, unit: 'dollars' } });
    expect(screen.getByText(money(50))).toBeInTheDocument();
  });

  it('formats zero', () => {
    render(CurrencyDisplay, { props: { amount: 0, unit: 'dollars' } });
    expect(screen.getByText(money(0))).toBeInTheDocument();
  });

  it('prefixes a minus sign for negative amounts', () => {
    render(CurrencyDisplay, { props: { amount: -2500 } }); // -$25.00
    expect(screen.getByText(`-${money(25)}`)).toBeInTheDocument();
  });

  it('formats a USD amount with the USD currency code', () => {
    render(CurrencyDisplay, {
      props: { amount: 1000, unit: 'dollars', currency: 'USD' },
    });
    expect(screen.getByText(money(1000, 'USD'))).toBeInTheDocument();
  });

  it('shows an explicit + sign for positive amounts when showSign is set', () => {
    render(CurrencyDisplay, {
      props: { amount: 1000, unit: 'dollars', showSign: true },
    });
    expect(screen.getByText(`+${money(1000)}`)).toBeInTheDocument();
  });

  it('shows a - sign for negatives when showSign is set', () => {
    render(CurrencyDisplay, {
      props: { amount: -1000, unit: 'dollars', showSign: true },
    });
    expect(screen.getByText(`-${money(1000)}`)).toBeInTheDocument();
  });

  it('does not add a sign to zero even when showSign is set', () => {
    render(CurrencyDisplay, {
      props: { amount: 0, unit: 'dollars', showSign: true },
    });
    const text = money(0);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText(`+${text}`)).not.toBeInTheDocument();
  });

  it('applies the negative highlight class only when highlightNegative and amount<0', () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: -100, unit: 'dollars', highlightNegative: true },
    });
    expect(container.querySelector('span')).toHaveClass('negative');
  });

  it('does not apply the negative class to a positive amount', () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 100, unit: 'dollars', highlightNegative: true },
    });
    expect(container.querySelector('span')).not.toHaveClass('negative');
  });

  it('applies the positive highlight class only when highlightPositive and amount>0', () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 100, unit: 'dollars', highlightPositive: true },
    });
    expect(container.querySelector('span')).toHaveClass('positive');
  });

  it.each([
    ['sm', 'sm'],
    ['lg', 'lg'],
  ] as const)('applies the %s size class', (size, cls) => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 100, unit: 'dollars', size },
    });
    expect(container.querySelector('span')).toHaveClass(cls);
  });

  it('appends a custom class alongside the base class', () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 100, unit: 'dollars', class: 'my-money' },
    });
    const span = container.querySelector('span');
    expect(span).toHaveClass('currency-display');
    expect(span).toHaveClass('my-money');
  });

  it('is axe-clean', async () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 12345 },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean for a highlighted negative value', async () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: -5000, highlightNegative: true },
    });
    await expectNoA11yViolations(container);
  });
});
