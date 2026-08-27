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

import { createHash } from 'node:crypto';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { render, screen } from '@testing-library/svelte';
import { hydrate, unmount } from 'svelte';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import CurrencyDisplay from '../CurrencyDisplay.svelte';
import { ISO_4217_MINOR_UNITS } from '../currency-metadata.js';
import CurrencyDisplaySsrHarness from './CurrencyDisplaySsrHarness.svelte';

function metadataDigest(metadata: ReadonlyMap<string, number | null>): string {
  const canonical = [...metadata.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, minorUnits]) => `${code}:${minorUnits ?? 'N.A.'}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Mirror the component's absolute-value currency formatting. */
function money(
  absDollars: number,
  currency = 'CAD',
  minorUnitDigits?: number,
): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    currencyDisplay:
      currency === 'CAD' || currency === 'USD' ? 'symbol' : 'code',
    minimumFractionDigits: minorUnitDigits,
    maximumFractionDigits: minorUnitDigits,
  }).format(absDollars);
}

describe('CurrencyDisplay', () => {
  it('matches the canonical digest of SIX List One 2026-01-01', () => {
    expect(ISO_4217_MINOR_UNITS.size).toBe(178);
    expect(metadataDigest(ISO_4217_MINOR_UNITS)).toBe(
      'e1a3c502511fa784b38dd7ac2b4056d00f3f1a9f5781df93b0f2352f8eedc976',
    );
  });

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

  it('formats an EUR amount through the public string currency prop', () => {
    const commerceCurrency: string = 'EUR';
    const { container } = render(CurrencyDisplay, {
      props: { amount: 12345, currency: commerceCurrency },
    });
    expect(container.querySelector('span')?.textContent).toBe(
      money(123.45, 'EUR'),
    );
  });

  it.each([
    ['JPY', 12345, '12,345'],
    ['BHD', 12345, '12.345'],
    ['IQD', 12345, '12.345'],
  ])('uses the ISO minor-unit scale for %s', (currency, amount, expected) => {
    const { container } = render(CurrencyDisplay, {
      props: { amount, currency },
    });
    expect(container.querySelector('span')?.textContent).toContain(expected);
  });

  it.each([
    ['IQD', 3, '9,007,199,254,740.991'],
    ['AFN', 2, '90,071,992,547,409.91'],
    ['CLF', 4, '900,719,925,474.0991'],
  ])('preserves the least-significant minor unit for large safe %s values', (currency, digits, expected) => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: Number.MAX_SAFE_INTEGER, currency },
    });
    const text = container.querySelector('span')?.textContent;
    expect(text).toContain(expected);
    expect(text?.split('.').at(-1)).toHaveLength(digits);
  });

  it.each([
    ['cad', 'CAD'],
    ['  eur  ', 'EUR'],
    ['ved', 'VED'],
    ['xad', 'XAD'],
  ])('normalizes the currency code %j to %s', (currency, normalized) => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 12345, currency },
    });
    expect(container.querySelector('span')?.textContent).toBe(
      money(123.45, normalized, 2),
    );
  });

  it.each([
    'US',
    'AAA',
    'ANG',
    'BGN',
    'CUC',
    'HRK',
    'SLL',
    'ZWL',
    'ZZZ',
    'uſd',
    'ıqd',
    'ßp',
    '',
  ])('renders invalid code %j without throwing', (currency) => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 12345, currency },
    });
    const normalized =
      currency
        .trim()
        .replace(/[a-z]/g, (character) => character.toUpperCase()) || '(empty)';
    const display = container.querySelector('.currency-display');
    expect(display).toHaveClass('invalid');
    expect(display).toHaveTextContent(`Invalid currency code: ${normalized}`);
  });

  it.each([
    ['uſd', 'UſD'],
    ['ıqd', 'ıQD'],
    ['ßp', 'ßP'],
  ])('preserves rejected non-ASCII input %j in its diagnostic as %s', (currency, diagnostic) => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 12345, currency },
    });
    expect(container.querySelector('.currency-display')).toHaveTextContent(
      `Invalid currency code: ${diagnostic}`,
    );
  });

  it('bounds malformed currency text so one row cannot force table overflow', () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 12345, currency: 'invalid-currency-code' },
    });
    expect(container.querySelector('.currency-display')).toHaveTextContent(
      'Invalid currency code: INVALID-CURR…',
    );
  });

  it('rejects a non-string currency from an untyped runtime caller without throwing', () => {
    const { container } = render(CurrencyDisplay, {
      // @ts-expect-error JavaScript callers can pass values outside the public type.
      props: { amount: 12345, currency: null },
    });
    const display = container.querySelector('.currency-display');
    expect(display).toHaveClass('invalid');
    expect(display).toHaveTextContent('Invalid currency code: (non-string)');
  });

  it('requires major-unit input for ISO codes without a minor unit', async () => {
    const { rerender } = render(CurrencyDisplay, {
      props: { amount: 12.5, currency: 'XAU' },
    });
    const display = document.querySelector('.currency-display');
    expect(display).toHaveClass('invalid');
    expect(display).toHaveTextContent('Currency code has no minor unit: XAU');

    await rerender({ amount: 12.5, currency: 'XAU', unit: 'dollars' });
    expect(document.querySelector('.currency-display')?.textContent).toBe(
      money(12.5, 'XAU', 2),
    );
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

  it('is axe-clean for an invalid currency code', async () => {
    const { container } = render(CurrencyDisplay, {
      props: { amount: 12345, currency: 'ZZZ' },
    });
    await expectNoA11yViolations(container);
  });

  it('renders and hydrates valid and invalid currencies safely', async () => {
    const vite = await createServer({
      appType: 'custom',
      configFile: false,
      plugins: [svelte()],
      root: process.cwd(),
      server: { middlewareMode: true },
    });

    try {
      const { default: SsrHarness } = await vite.ssrLoadModule(
        '/src/components/display/__tests__/CurrencyDisplaySsrHarness.svelte',
      );
      const { render: renderSsr } = await vite.ssrLoadModule('svelte/server');
      const result = renderSsr(SsrHarness);
      expect(result.body).toContain(money(123.45, 'EUR'));
      expect(result.body).toContain('Invalid currency code: ZZZ');
      expect(result.body).toContain('Currency code has no minor unit: XAU');

      const host = document.createElement('div');
      host.innerHTML = result.body;
      document.body.append(host);
      const instance = hydrate(CurrencyDisplaySsrHarness, { target: host });
      expect(host.textContent).toContain(money(123.45, 'EUR'));
      expect(host.textContent).toContain('Invalid currency code: ZZZ');
      expect(host.textContent).toContain(
        'Currency code has no minor unit: XAU',
      );
      await unmount(instance);
      host.remove();
    } finally {
      await vite.close();
    }
  });
});
