<script module lang="ts">
// Active ISO 4217 currency and fund codes. Keep validation independent of the
// host's ICU data so server and browser rendering agree on the same input.
const ISO_4217_CODES = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XTS XUA XXX YER ZAR ZMW ZWG ZWL`.split(
    ' ',
  ),
);

function normalizeCurrencyCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;

  return ISO_4217_CODES.has(normalized) ? normalized : null;
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
    const invalidCode = currency.trim().toUpperCase() || '(empty)';
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

  const minorUnitDigits = formatter.resolvedOptions().maximumFractionDigits;
  if (minorUnitDigits === undefined) {
    return {
      text: `Invalid currency code: ${normalizedCurrency}`,
      invalidCode: normalizedCurrency,
    };
  }
  const majorAmount =
    unit === 'cents' ? amount / 10 ** minorUnitDigits : amount;
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
