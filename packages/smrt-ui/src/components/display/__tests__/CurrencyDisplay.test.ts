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

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { render, screen } from '@testing-library/svelte';
import { hydrate, unmount } from 'svelte';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import CurrencyDisplay from '../CurrencyDisplay.svelte';
import { ISO_4217_MINOR_UNITS } from '../currency-metadata.js';
import CurrencyDisplaySsrHarness from './CurrencyDisplaySsrHarness.svelte';

function metadataEntries(
  codes: string,
  minorUnits: number | null,
): Array<[string, number | null]> {
  return codes.split(' ').map((code) => [code, minorUnits]);
}

const OFFICIAL_LIST_ONE_2026_01_01 = new Map<string, number | null>([
  ...metadataEntries(
    'XOF BIF XAF CLP KMF DJF XPF GNF ISK JPY KRW PYG RWF UGX UYI VUV VND',
    0,
  ),
  ...metadataEntries(
    'AFN EUR ALL DZD USD AOA XCD XAD ARS AMD AWG AUD AZN BSD BDT BBD BYN BZD BMD INR BTN BOB BOV BAM BWP NOK BRL BND CVE KHR CAD KYD CNY COP COU CDF NZD CRC CUP XCG CZK DKK DOP EGP SVC ERN SZL ETB FKP FJD GMD GEL GHS GIP GTQ GBP GYD HTG HNL HKD HUF IDR IRR ILS JMD KZT KES KPW KGS LAK LBP LSL ZAR LRD CHF MOP MKD MGA MWK MYR MVR MRU MUR MXN MXV MDL MNT MAD MZN MMK NAD NPR NIO NGN PKR PAB PGK PEN PHP PLN QAR RON RUB SHP WST STN SAR RSD SCR SLE SGD SBD SOS SSP LKR SDG SRD SEK CHE CHW SYP TWD TJS TZS THB TOP TTD TRY TMT UAH AED USN UYU UZS VES VED YER ZMW ZWG',
    2,
  ),
  ...metadataEntries('BHD IQD JOD KWD LYD OMR TND', 3),
  ...metadataEntries('CLF UYW', 4),
  ...metadataEntries(
    'XDR XUA XSU XBA XBB XBC XBD XTS XXX XAU XPD XPT XAG',
    null,
  ),
]);

/** Mirror the component's absolute-value currency formatting. */
function money(
  absDollars: number,
  currency = 'CAD',
  minorUnitDigits?: number,
): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: minorUnitDigits,
    maximumFractionDigits: minorUnitDigits,
  }).format(absDollars);
}

describe('CurrencyDisplay', () => {
  it('matches all 178 codes and exponents in SIX List One 2026-01-01', () => {
    expect(ISO_4217_MINOR_UNITS).toEqual(OFFICIAL_LIST_ONE_2026_01_01);
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
    render(CurrencyDisplay, {
      props: { amount: 12345, currency: commerceCurrency },
    });
    expect(screen.getByText(money(123.45, 'EUR'))).toBeInTheDocument();
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
    '',
  ])('renders invalid code %j without throwing', (currency) => {
    render(CurrencyDisplay, {
      props: { amount: 12345, currency },
    });
    const normalized = currency.trim().toUpperCase() || '(empty)';
    expect(
      screen.getByRole('status', {
        name: `Invalid currency code: ${normalized}`,
      }),
    ).toHaveClass('invalid');
  });

  it('rejects a non-string currency from an untyped runtime caller without throwing', () => {
    render(CurrencyDisplay, {
      // @ts-expect-error JavaScript callers can pass values outside the public type.
      props: { amount: 12345, currency: null },
    });
    expect(
      screen.getByRole('status', {
        name: 'Invalid currency code: (non-string)',
      }),
    ).toHaveClass('invalid');
  });

  it('requires major-unit input for ISO codes without a minor unit', async () => {
    const { rerender } = render(CurrencyDisplay, {
      props: { amount: 12.5, currency: 'XAU' },
    });
    expect(
      screen.getByRole('status', {
        name: 'Currency code has no minor unit: XAU',
      }),
    ).toHaveClass('invalid');

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
