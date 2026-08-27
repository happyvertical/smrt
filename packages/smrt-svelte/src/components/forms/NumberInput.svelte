<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import { M } from '../../i18n/strings.forms.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { invalidStagedValue } from './prepare-field-value.js';

const { t } = useI18n();

export interface Props {
  /** Field name */
  name: string;
  /** Field label */
  label?: string;
  /** Description for voice extraction */
  description?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Current value (bindable) */
  value?: number | null;
  /** Minimum value */
  min?: number;
  /** Maximum value */
  max?: number;
  /** Step increment */
  step?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Called when value changes */
  onchange?: (value: number | null) => void;
}

let {
  name,
  label,
  description,
  placeholder = '',
  value = $bindable(null),
  min,
  max,
  step = 1,
  disabled = false,
  required = false,
  onchange,
}: Props = $props();

const app = useAppState();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

// Validation
function numberIsInRange(candidate: number | null): boolean {
  if (candidate === null) return true;
  if (min !== undefined && candidate < min) return false;
  if (max !== undefined && candidate > max) return false;
  return true;
}
function numberMatchesStep(candidate: number): boolean {
  if (!Number.isFinite(step) || step <= 0) return true;
  const offset = (candidate - (min ?? 0)) / step;
  return Math.abs(offset - Math.round(offset)) <= 1e-9;
}
const isInRange = $derived(numberIsInRange(value));
const showInvalid = $derived(value !== null && !isInRange);

function updateValue(newValue: number | null) {
  value = newValue;
  onchange?.(value);
}

// Parse spoken number text to number
function parseSpokenNumber(text: string): number | null {
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

  // Try direct parse first
  const direct = parseFloat(normalized.replace(/[,$]/g, ''));
  if (!Number.isNaN(direct)) {
    return direct;
  }

  // Try word parsing
  if (wordNumbers[normalized] !== undefined) {
    return wordNumbers[normalized];
  }

  // Handle compound numbers like "twenty five"
  const parts = normalized.split(/[\s-]+/);
  let result = 0;
  let current = 0;

  for (const part of parts) {
    const num = wordNumbers[part];
    if (num !== undefined) {
      if (num >= 100) {
        current = current === 0 ? num : current * num;
        if (num >= 1000) {
          result += current;
          current = 0;
        }
      } else {
        current += num;
      }
    }
  }

  result += current;
  return result > 0 ? result : null;
}

// Register with form context
$effect(() => {
  if (formContext) {
    const registeredName = name;
    const fieldDef: FieldDefinition = {
      name: registeredName,
      type: 'number',
      get label() {
        return label;
      },
      get description() {
        let rangeDescription = '';
        if (min !== undefined && max !== undefined) {
          rangeDescription = ` (between ${min} and ${max})`;
        } else if (min !== undefined) {
          rangeDescription = ` (minimum ${min})`;
        } else if (max !== undefined) {
          rangeDescription = ` (maximum ${max})`;
        }
        return (description || 'A number') + rangeDescription;
      },
      setValue: (v: unknown) => {
        if (v === null || v === undefined || v === '') {
          updateValue(null);
          return;
        }
        if (typeof v === 'number') {
          updateValue(v);
          return;
        }
        // Try to parse spoken number
        const parsed = parseSpokenNumber(String(v));
        if (parsed !== null) {
          updateValue(parsed);
        }
      },
      getValue: () => value,
      prepareValue: (candidate) => {
        if (candidate === null || candidate === undefined || candidate === '') {
          return null;
        }
        if (typeof candidate === 'number') {
          return candidate;
        }
        if (typeof candidate !== 'string') return invalidStagedValue();
        return parseSpokenNumber(candidate) ?? invalidStagedValue();
      },
      getState: () => ({ disabled }),
      get constraints() {
        return { required, min, max, step };
      },
      validateValue: (candidate) => {
        if (candidate === null || candidate === undefined || candidate === '') {
          return !required;
        }
        const proposed =
          typeof candidate === 'number'
            ? candidate
            : parseSpokenNumber(String(candidate));
        return (
          proposed !== null &&
          Number.isFinite(proposed) &&
          numberIsInRange(proposed) &&
          numberMatchesStep(proposed)
        );
      },
      validate: () =>
        value === null ? !required : Number.isFinite(value) && isInRange,
    };
    return formContext.registerField(fieldDef);
  }
});

function handleInput(e: Event) {
  const target = e.target as HTMLInputElement;
  const val = target.value === '' ? null : parseFloat(target.value);
  updateValue(val);
}
</script>

<div class="smrt-number">
  {#if label}
    <label for={name} class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="input-wrapper">
    <input
      id={name}
      {name}
      type="number"
      {placeholder}
      value={value ?? ''}
      {min}
      {max}
      {step}
      {disabled}
      {required}
      class="smrt-input"
      class:smrt-mode={isSmrt}
      class:invalid={showInvalid}
      aria-invalid={showInvalid ? 'true' : undefined}
      aria-describedby={showInvalid ? `${name}-error` : undefined}
      oninput={handleInput}
    />
  </div>

  {#if showInvalid}
    <div id={`${name}-error`} class="validation-error" role="alert">
      {#if min !== undefined && value !== null && value < min}
        {t(M['ui.number_input.value_at_least'], { min })}
      {:else if max !== undefined && value !== null && value > max}
        {t(M['ui.number_input.value_at_most'], { max })}
      {/if}
    </div>
  {/if}
</div>

<style>
  .smrt-number {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
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
  }

  .smrt-input {
    flex: 1;
    box-sizing: border-box;
    min-width: 0;
    width: 100%;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 6px);
    background: var(--smrt-color-surface, #fff);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
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

  /* Hide spinner buttons */
  .smrt-input::-webkit-outer-spin-button,
  .smrt-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .smrt-input[type=number] {
    appearance: textfield;
    -moz-appearance: textfield;
  }

  .validation-error {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #ba1a1a);
    margin-top: var(--smrt-spacing-1, 4px);
  }
</style>
