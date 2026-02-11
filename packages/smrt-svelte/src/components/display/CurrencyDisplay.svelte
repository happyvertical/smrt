<script lang="ts">
/**
 * CurrencyDisplay - Formats and displays monetary values
 *
 * Takes amount in cents and displays formatted currency.
 * Supports CAD/USD with appropriate symbols and locale formatting.
 */

interface Props {
  /** Amount value */
  amount: number;
  /** Currency code */
  currency?: 'CAD' | 'USD';
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
}

const {
  amount,
  currency = 'CAD',
  unit = 'cents',
  showSign = false,
  size = 'md',
  highlightNegative = false,
  highlightPositive = false,
}: Props = $props();

// Format amount using Intl.NumberFormat
const formatted = $derived.by(() => {
  const dollars = unit === 'cents' ? amount / 100 : amount;
  const absValue = Math.abs(dollars);

  const formatter = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  let display = formatter.format(absValue);

  // Add sign if requested
  if (showSign && amount !== 0) {
    const sign = amount > 0 ? '+' : '-';
    display = sign + display;
  } else if (amount < 0) {
    display = `-${display}`;
  }

  return display;
});

// Determine color class
const colorClass = $derived.by(() => {
  if (highlightNegative && amount < 0) return 'negative';
  if (highlightPositive && amount > 0) return 'positive';
  return '';
});
</script>

<span
  class="currency-display"
  class:sm={size === 'sm'}
  class:lg={size === 'lg'}
  class:negative={colorClass === 'negative'}
  class:positive={colorClass === 'positive'}
>
  {formatted}
</span>

<style>
  .currency-display {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .currency-display.sm {
    font-size: 0.875rem;
  }

  .currency-display.lg {
    font-size: 1.25rem;
    font-weight: 600;
  }

  .currency-display.negative {
    color: #dc2626;
  }

  .currency-display.positive {
    color: #16a34a;
  }
</style>
