<script module lang="ts">
import { ISO_4217_MINOR_UNITS } from './currency-metadata.js';

interface NormalizedCurrency {
  code: string;
  minorUnitDigits: number | null;
}

function normalizeCurrencyCode(value: unknown): NormalizedCurrency | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z]{3}$/.test(trimmed)) return null;
  const code = trimmed.toUpperCase();

  const minorUnitDigits = ISO_4217_MINOR_UNITS.get(code);
  return minorUnitDigits === undefined ? null : { code, minorUnitDigits };
}

function invalidCurrencyCode(value: unknown): string {
  if (typeof value !== 'string') return '(non-string)';
  const characters = Array.from(value.trim());
  if (characters.length === 0) return '(empty)';

  let diagnostic = '';
  let consumed = 0;
  for (const character of characters) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const visibleCharacter =
      codePoint >= 0x20 && codePoint <= 0x7e
        ? character.replace(/[a-z]/g, (ascii) => ascii.toUpperCase())
        : `\\u{${codePoint.toString(16).toUpperCase()}}`;
    if (diagnostic.length + visibleCharacter.length > 12) break;
    diagnostic += visibleCharacter;
    consumed += 1;
  }

  return consumed < characters.length ? `${diagnostic}…` : diagnostic;
}

function isStringNumericLiteral(
  value: string,
): value is Intl.StringNumericLiteral {
  return /^(?:0|[1-9]\d*)\.\d+$/.test(value);
}

function exactMajorUnitValue(
  amount: number,
  minorUnitDigits: number,
): bigint | Intl.StringNumericLiteral | null {
  const absoluteAmount = Math.abs(amount);
  if (!Number.isSafeInteger(absoluteAmount)) return null;

  const minorUnits = BigInt(absoluteAmount);
  if (minorUnitDigits === 0) return minorUnits;

  const scale = 10n ** BigInt(minorUnitDigits);
  const exactValue = `${minorUnits / scale}.${(minorUnits % scale)
    .toString()
    .padStart(minorUnitDigits, '0')}`;
  return isStringNumericLiteral(exactValue) ? exactValue : null;
}
</script>

<script lang="ts">
import { M } from '../../i18n/strings.js';
import { useI18n } from '../../i18n/use-i18n.js';

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
  /** Whether amount is a safe integer of ISO minor units or a major-unit number */
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

const { t } = useI18n();

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
      text: t(M['ui.currency_display.invalid_code'], { code: invalidCode }),
      invalidCode,
    };
  }

  const formatOptions: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: normalizedCurrency.code,
    // CAD and USD retain their historical symbol display. Using the ISO code
    // for every other currency avoids ICU-dependent narrow-symbol differences
    // between server and browser runtimes.
    currencyDisplay:
      normalizedCurrency.code === 'CAD' || normalizedCurrency.code === 'USD'
        ? 'symbol'
        : 'code',
  };
  const displayDigits = normalizedCurrency.minorUnitDigits ?? 2;
  formatOptions.minimumFractionDigits = displayDigits;
  formatOptions.maximumFractionDigits = displayDigits;

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat('en-CA', formatOptions);
  } catch {
    return {
      text: t(M['ui.currency_display.invalid_code'], {
        code: normalizedCurrency.code,
      }),
      invalidCode: normalizedCurrency.code,
    };
  }

  let majorAmount: number | bigint | Intl.StringNumericLiteral =
    Math.abs(amount);
  if (unit === 'cents') {
    if (normalizedCurrency.minorUnitDigits == null) {
      return {
        text: t(M['ui.currency_display.no_minor_unit'], {
          code: normalizedCurrency.code,
        }),
        invalidCode: normalizedCurrency.code,
      };
    }
    const exactAmount = exactMajorUnitValue(
      amount,
      normalizedCurrency.minorUnitDigits,
    );
    if (exactAmount === null) {
      return {
        text: t(M['ui.currency_display.invalid_minor_unit_amount']),
        invalidCode: normalizedCurrency.code,
      };
    }
    majorAmount = exactAmount;
  }
  let display = formatter.format(majorAmount);

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
