/**
 * Currency formatting for integer minor units (#2401).
 *
 * `formatCurrency` receives what the database stores — integer minor units —
 * and `Intl.NumberFormat` formats major units, so the scale has to be undone
 * first. Which scale depends on the currency, which is the trap this file
 * guards: a hard-coded `/100`, or a `minimumFractionDigits: 2` override that
 * pins the resolved exponent to 2, both mis-render every currency that does not
 * have exactly two decimal places.
 */

import { describe, expect, it } from 'vitest';
import { formatCurrency as formatCurrencyFromComponents } from './components/utils.js';
import { formatCurrency } from './utils.js';

describe('formatCurrency (#2401)', () => {
  it('renders a two-decimal currency by undoing the cent scale', () => {
    // 19999 minor units is $199.99, not $19,999.00.
    expect(formatCurrency(19999, 'CAD')).toContain('199.99');
    expect(formatCurrency(19999, 'CAD')).not.toContain('19,999');
  });

  it('renders zero as the currency zero rather than nothing', () => {
    expect(formatCurrency(0, 'CAD')).toContain('0.00');
  });

  it('does not rescale or add decimals to a zero-decimal currency', () => {
    // JPY has no minor unit, so 1999 is ¥1,999 — dividing by 100 here would
    // report ¥19.99, a hundredfold understatement, and printing two decimals
    // would invent a fractional part the currency does not have.
    const formatted = formatCurrency(1999, 'JPY' as never);
    expect(formatted).toContain('1,999');
    expect(formatted).not.toContain('1,999.00');
  });

  it('uses a three-decimal currency exponent for a three-decimal currency', () => {
    // BHD is 1000 fils to the dinar, so 1999 fils is BHD 1.999.
    expect(formatCurrency(1999, 'BHD' as never)).toContain('1.999');
  });

  it('is duplicated verbatim under components/, so both copies must agree', () => {
    for (const [amount, currency] of [
      [19999, 'CAD'],
      [1999, 'JPY'],
      [0, 'USD'],
    ] as const) {
      expect(formatCurrencyFromComponents(amount, currency as never)).toBe(
        formatCurrency(amount, currency as never),
      );
    }
  });
});
