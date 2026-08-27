<script module lang="ts">
let currencyNames: Intl.DisplayNames | null | undefined;

function normalizeCurrencyCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;

  try {
    if (currencyNames === undefined) {
      currencyNames =
        typeof Intl.DisplayNames === 'function'
          ? new Intl.DisplayNames(['en'], {
              type: 'currency',
              fallback: 'none',
            })
          : null;
    }
    return !currencyNames || currencyNames.of(normalized) ? normalized : null;
  } catch {
    // NumberFormat remains the compatibility validator when DisplayNames is
    // unavailable or the runtime does not ship currency-name locale data.
    currencyNames = null;
    return normalized;
  }
}
</script>

<script lang="ts">
/**
 * CurrencyDisplay - Formats and displays monetary values
 *
 * Displays formatted currency with configurable unit.
 * Use `unit="cents"` (default) when amount is in cents, or `unit="dollars"` for dollar values.
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
  /** Whether amount is in cents or dollars (default: cents) */
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

  const dollars = unit === 'cents' ? amount / 100 : amount;
  const absValue = Math.abs(dollars);

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: normalizedCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    return {
      text: `Invalid currency code: ${normalizedCurrency}`,
      invalidCode: normalizedCurrency,
    };
  }

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
