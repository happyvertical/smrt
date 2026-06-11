<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';

export interface Props {
  /** Field name */
  name: string;
  /** Field label */
  label?: string;
  /** Description for voice extraction */
  description?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Current value in cents (bindable) */
  value?: number | null;
  /** Currency code for display */
  currency?: 'CAD' | 'USD';
  /** Minimum value in cents */
  min?: number;
  /** Maximum value in cents */
  max?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Error message to display */
  error?: string;
  /** Called when value changes */
  onchange?: (cents: number | null) => void;
}

let {
  name,
  label,
  description,
  placeholder = '0.00',
  value = $bindable(null),
  currency = 'CAD',
  min,
  max,
  disabled = false,
  required = false,
  error,
  onchange,
}: Props = $props();

const app = useAppState();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

// Format cents to display string (e.g., 15000 -> "150.00")
function centsToDisplay(cents: number | null): string {
  if (cents === null) return '';
  return (cents / 100).toFixed(2);
}

// Parse display string to cents (e.g., "150.00" -> 15000)
function displayToCents(displayValue: string): number | null {
  const cleaned = displayValue.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const parsed = parseFloat(cleaned);
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed * 100);
}

// Display value for input
let displayValue = $state(centsToDisplay(value));

// Keep display in sync with external value changes
$effect(() => {
  const newDisplay = centsToDisplay(value);
  if (displayValue !== newDisplay && !isFocused) {
    displayValue = newDisplay;
  }
});

let isFocused = $state(false);

// Currency symbol - differentiate between USD and CAD
const currencySymbol = $derived(currency === 'USD' ? 'US$' : 'CA$');

// Validation
const isInRange = $derived.by(() => {
  if (value === null) return true;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
});
const showInvalid = $derived((value !== null && !isInRange) || !!error);

function updateValue(cents: number | null) {
  value = cents;
  onchange?.(value);
}

// Parse spoken money text to cents
function parseSpokenMoney(text: string): number | null {
  const normalized = text.toLowerCase().trim();

  // Word to number mapping
  const wordNumbers: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
    hundred: 100,
    thousand: 1000,
    million: 1000000,
  };

  // Check for currency keywords
  const hasDollars = /dollar|buck|cad|usd/i.test(normalized);
  const hasCents = /cent/i.test(normalized);

  // Remove currency words for parsing
  let cleanText = normalized
    .replace(/\$|dollar[s]?|buck[s]?|cad|usd|cent[s]?/gi, '')
    .trim();

  // Try direct parse first (e.g., "$150.00" or "150.00")
  const directMatch = cleanText.match(/[\d,.]+/);
  if (directMatch) {
    const direct = parseFloat(directMatch[0].replace(/,/g, ''));
    if (!Number.isNaN(direct)) {
      // If cents keyword found, value is already in cents
      if (hasCents && !hasDollars) {
        return Math.round(direct);
      }
      // Otherwise, value is in dollars - convert to cents
      return Math.round(direct * 100);
    }
  }

  // Handle compound like "twenty five fifty" = $25.50
  const parts = cleanText.split(/[\s-]+/).filter(Boolean);
  let dollars = 0;
  let cents = 0;
  let current = 0;
  let foundDecimalWord = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const num = wordNumbers[part];

    // Check for "and" or small numbers after main amount (likely cents)
    if (part === 'and' || part === 'point') {
      foundDecimalWord = true;
      dollars += current;
      current = 0;
      continue;
    }

    if (num !== undefined) {
      if (num >= 100) {
        current = current === 0 ? num : current * num;
        if (num >= 1000) {
          if (foundDecimalWord) {
            cents += current;
          } else {
            dollars += current;
          }
          current = 0;
        }
      } else {
        current += num;
      }
    }
  }

  if (foundDecimalWord) {
    cents += current;
    // Handle cents overflow (e.g., "one hundred fifty cents" = 150 cents = $1.50)
    if (cents > 99) {
      dollars += Math.floor(cents / 100);
      cents = cents % 100;
    }
  } else {
    dollars += current;
  }

  const totalCents = dollars * 100 + cents;
  return totalCents > 0 ? totalCents : null;
}

// Register with form context
onMount(() => {
  if (formContext) {
    let rangeDesc = '';
    if (min !== undefined && max !== undefined) {
      rangeDesc = ` (between $${(min / 100).toFixed(2)} and $${(max / 100).toFixed(2)})`;
    } else if (min !== undefined) {
      rangeDesc = ` (minimum $${(min / 100).toFixed(2)})`;
    } else if (max !== undefined) {
      rangeDesc = ` (maximum $${(max / 100).toFixed(2)})`;
    }

    const fieldDef: FieldDefinition = {
      name,
      type: 'money',
      label,
      description: (description || 'A monetary amount in dollars') + rangeDesc,
      setValue: (v: unknown) => {
        if (v === null || v === undefined || v === '') {
          updateValue(null);
          displayValue = '';
          return;
        }
        if (typeof v === 'number') {
          // Assume number input is in cents
          updateValue(v);
          displayValue = centsToDisplay(v);
          return;
        }
        // Try to parse spoken money
        const parsed = parseSpokenMoney(String(v));
        if (parsed !== null) {
          updateValue(parsed);
          displayValue = centsToDisplay(parsed);
        }
      },
      getValue: () => value,
    };
    formContext.registerField(fieldDef);
  }
});

onDestroy(() => {
  if (formContext) {
    formContext.unregisterField(name);
  }
});

function handleInput(e: Event) {
  const target = e.target as HTMLInputElement;
  displayValue = target.value;
  const cents = displayToCents(target.value);
  updateValue(cents);
}

function handleFocus() {
  isFocused = true;
}

function handleBlur() {
  isFocused = false;
  // Reformat display value on blur
  displayValue = centsToDisplay(value);
}
</script>

<div class="smrt-money">
  {#if label}
    <label for={name} class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="input-wrapper">
    <span class="currency-symbol">{currencySymbol}</span>
    <input
      id={name}
      {name}
      type="text"
      inputmode="decimal"
      placeholder={placeholder}
      value={displayValue}
      {disabled}
      {required}
      class="smrt-input"
      class:smrt-mode={isSmrt}
      class:invalid={showInvalid}
      aria-invalid={showInvalid ? 'true' : undefined}
      aria-describedby={showInvalid ? `${name}-error` : undefined}
      oninput={handleInput}
      onfocus={handleFocus}
      onblur={handleBlur}
    />
    <span class="currency-code">{currency}</span>
  </div>

  <!-- Hidden input for form submission with cents value -->
  <input type="hidden" name="{name}_cents" value={value ?? ''} />

  {#if error}
    <div id={`${name}-error`} class="validation-error" role="alert">{error}</div>
  {:else if showInvalid && !isInRange}
    <div id={`${name}-error`} class="validation-error" role="alert">
      {#if min !== undefined && value !== null && value < min}
        Value must be at least ${(min / 100).toFixed(2)}
      {:else if max !== undefined && value !== null && value > max}
        Value must be at most ${(max / 100).toFixed(2)}
      {/if}
    </div>
  {/if}
</div>

<style>
  .smrt-money {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
  }

  .smrt-label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface, #374151);
  }

  .smrt-label .required {
    color: var(--smrt-color-error, #ba1a1a);
    margin-left: var(--smrt-spacing-1, 4px);
  }

  .input-wrapper {
    display: flex;
    position: relative;
    align-items: center;
  }

  .currency-symbol {
    position: absolute;
    left: 12px;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    pointer-events: none;
  }

  .currency-code {
    position: absolute;
    right: 12px;
    color: var(--smrt-color-on-surface-variant, #9ca3af);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
    pointer-events: none;
  }

  .smrt-input {
    flex: 1;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-12, 48px) var(--smrt-spacing-2, 8px) var(--smrt-spacing-7, 28px);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 6px);
    background: var(--smrt-color-surface, #fff);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
    text-align: right;
  }

  .smrt-input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
  }

  .smrt-input:disabled {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    cursor: not-allowed;
  }

  .smrt-input.smrt-mode {
    border-color: var(--smrt-color-tertiary, #6b5778);
  }

  .smrt-input.invalid {
    border-color: var(--smrt-color-error, #ba1a1a);
  }

  .smrt-input.invalid:focus {
    border-color: var(--smrt-color-error);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-error, #ba1a1a) 10%, transparent);
  }

  .validation-error {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #ba1a1a);
    margin-top: var(--smrt-spacing-1, 4px);
  }
</style>
