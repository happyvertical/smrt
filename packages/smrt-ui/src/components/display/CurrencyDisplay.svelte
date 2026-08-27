<script module lang="ts">
function minorUnitEntries(
  codes: string,
  minorUnits: number | null,
): Array<[string, number | null]> {
  return codes.split(' ').map((code) => [code, minorUnits]);
}

// ISO 4217 List One, published by the ISO maintenance agency SIX on
// 2026-01-01. Keeping both membership and minor-unit exponents here makes SSR
// and browser rendering independent of their potentially different ICU data.
// Source: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
const ISO_4217_MINOR_UNITS = new Map<string, number | null>([
  ...minorUnitEntries(
    'XOF BIF XAF CLP KMF DJF XPF GNF ISK JPY KRW PYG RWF UGX UYI VUV VND',
    0,
  ),
  ...minorUnitEntries(
    'AFN EUR ALL DZD USD AOA XCD XAD ARS AMD AWG AUD AZN BSD BDT BBD BYN BZD BMD INR BTN BOB BOV BAM BWP NOK BRL BND CVE KHR CAD KYD CNY COP COU CDF NZD CRC CUP XCG CZK DKK DOP EGP SVC ERN SZL ETB FKP FJD GMD GEL GHS GIP GTQ GBP GYD HTG HNL HKD HUF IDR IRR ILS JMD KZT KES KPW KGS LAK LBP LSL ZAR LRD CHF MOP MKD MGA MWK MYR MVR MRU MUR MXN MXV MDL MNT MAD MZN MMK NAD NPR NIO NGN PKR PAB PGK PEN PHP PLN QAR RON RUB SHP WST STN SAR RSD SCR SLE SGD SBD SOS SSP LKR SDG SRD SEK CHE CHW SYP TWD TJS TZS THB TOP TTD TRY TMT UAH AED USN UYU UZS VES VED YER ZMW ZWG',
    2,
  ),
  ...minorUnitEntries('BHD IQD JOD KWD LYD OMR TND', 3),
  ...minorUnitEntries('CLF UYW', 4),
  ...minorUnitEntries(
    'XDR XUA XSU XBA XBB XBC XBD XTS XXX XAU XPD XPT XAG',
    null,
  ),
]);

function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;

  return ISO_4217_MINOR_UNITS.has(normalized) ? normalized : null;
}

function invalidCurrencyCode(value: unknown): string {
  if (typeof value !== 'string') return '(non-string)';
  return value.trim().toUpperCase() || '(empty)';
}
</script>

<script lang="ts">
/**
 * CurrencyDisplay - Formats and displays monetary values
 *
 * Displays formatted currency with configurable unit.
 * Use `unit="cents"` (default) when amount is in the currency's minor units,
 * or `unit="dollars"` when it is already in major units.
 * Accepts ISO 4217 currency codes, normalized by trimming whitespace and
 * uppercasing before locale formatting. Unsupported codes render an accessible
 * inline error instead of throwing during a collection render.
 */

/** Props for CurrencyDisplay component */
export interface Props {
  /** Amount value */
  amount: number;
  /** ISO 4217 currency code. Whitespace is trimmed and letters are uppercased. */
  currency?: string;
  /** Whether amount is in ISO minor units or major units (default: cents/minor units) */
  unit?: 'cents' | 'dollars';
  /** Show +/- sign for non-zero values */
  showSign?: boolean;
  /** Display size */
  size?: 'sm' | 'md' | 'lg';
  /** Highlight negative values in red */
  highlightNegative?: boolean;
  /** Highlight positive values in green */
  highlightPositive?: boolean;
  /** Optional CSS class */
  class?: string;
}

const {
  amount,
  currency = 'CAD',
  unit = 'cents',
  showSign = false,
  size = 'md',
  highlightNegative = false,
  highlightPositive = false,
  class: className = '',
}: Props = $props();

interface FormattedCurrency {
  text: string;
  invalidCode: string | null;
}

// Format amount using the platform's canonical currency formatter.
const formatted = $derived.by((): FormattedCurrency => {
  const normalizedCurrency = normalizeCurrencyCode(currency);
  if (!normalizedCurrency) {
    const invalidCode = invalidCurrencyCode(currency);
    return {
      text: `Invalid currency code: ${invalidCode}`,
      invalidCode,
    };
  }

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: normalizedCurrency,
    });
  } catch {
    return {
      text: `Invalid currency code: ${normalizedCurrency}`,
      invalidCode: normalizedCurrency,
    };
  }

  const minorUnitDigits = ISO_4217_MINOR_UNITS.get(normalizedCurrency);
  let majorAmount = amount;
  if (unit === 'cents') {
    if (minorUnitDigits == null) {
      return {
        text: `Currency code has no minor unit: ${normalizedCurrency}`,
        invalidCode: normalizedCurrency,
      };
    }
    majorAmount = amount / 10 ** minorUnitDigits;
  }
  const absValue = Math.abs(majorAmount);
  let display = formatter.format(absValue);

  // Add sign if requested
  if (showSign && amount !== 0) {
    const sign = amount > 0 ? '+' : '-';
    display = sign + display;
  } else if (amount < 0) {
    display = `-${display}`;
  }

  return { text: display, invalidCode: null };
});

// Determine color class
const colorClass = $derived.by(() => {
  if (highlightNegative && amount < 0) return 'negative';
  if (highlightPositive && amount > 0) return 'positive';
  return '';
});
</script>

<span
  class="currency-display {className}"
  class:sm={size === 'sm'}
  class:lg={size === 'lg'}
  class:negative={colorClass === 'negative'}
  class:positive={colorClass === 'positive'}
  class:invalid={formatted.invalidCode !== null}
  role={formatted.invalidCode !== null ? 'status' : undefined}
  aria-label={formatted.invalidCode !== null ? formatted.text : undefined}
>
  {formatted.text}
</span>

<style>
  .currency-display {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .currency-display.sm {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .currency-display.lg {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-title-large-weight, 600);
  }

  .currency-display.negative {
    color: var(--smrt-color-error, #dc2626);
  }

  .currency-display.positive {
    color: var(--smrt-color-tertiary, #16a34a);
  }

  .currency-display.invalid {
    color: var(--smrt-color-error, #dc2626);
  }
</style>
