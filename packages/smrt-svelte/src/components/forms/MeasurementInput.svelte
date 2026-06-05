<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import type { MeasurementUnit, MeasurementValue } from './types.js';

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
  /** Current unit (bindable) */
  unit?: MeasurementUnit;
  /** Available units to choose from */
  units?: MeasurementUnit[];
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
  /** Error message to display */
  error?: string;
  /** Called when value changes */
  onchange?: (measurement: MeasurementValue | null) => void;
}

const unitLabels: Record<MeasurementUnit, string> = {
  ft: 'Feet',
  in: 'Inches',
  m: 'Meters',
  cm: 'Centimeters',
  mm: 'Millimeters',
  yd: 'Yards',
};

const unitAbbreviations: Record<MeasurementUnit, string> = {
  ft: 'ft',
  in: 'in',
  m: 'm',
  cm: 'cm',
  mm: 'mm',
  yd: 'yd',
};

// Conversion factors to meters (base unit)
const toMeters: Record<MeasurementUnit, number> = {
  ft: 0.3048,
  in: 0.0254,
  m: 1,
  cm: 0.01,
  mm: 0.001,
  yd: 0.9144,
};

let {
  name,
  label,
  description,
  placeholder = '0',
  value = $bindable(null),
  unit = $bindable('ft' as MeasurementUnit),
  units = ['ft', 'in', 'm', 'cm'],
  min,
  max,
  step = 0.01,
  disabled = false,
  required = false,
  error,
  onchange,
}: Props = $props();

const app = useAppState();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

// Validation
const isInRange = $derived.by(() => {
  if (value === null) return true;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
});
const showInvalid = $derived((value !== null && !isInRange) || !!error);

function updateValue(newValue: number | null, newUnit?: MeasurementUnit) {
  value = newValue;
  if (newUnit !== undefined) {
    unit = newUnit;
  }
  onchange?.(value !== null ? { value, unit } : null);
}

// Convert between units
function convert(
  val: number,
  fromUnit: MeasurementUnit,
  toUnit: MeasurementUnit,
): number {
  if (fromUnit === toUnit) return val;
  const meters = val * toMeters[fromUnit];
  return meters / toMeters[toUnit];
}

// Parse spoken measurement text
function parseSpokenMeasurement(text: string): MeasurementValue | null {
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
    half: 0.5,
    quarter: 0.25,
    third: 0.333,
  };

  // Unit patterns
  const unitPatterns: Array<{ pattern: RegExp; unit: MeasurementUnit }> = [
    { pattern: /\b(?:feet|foot|ft)\b/i, unit: 'ft' },
    { pattern: /\b(?:inch(?:es)?|in)\b/i, unit: 'in' },
    { pattern: /\b(?:meter[s]?|metre[s]?|m)\b/i, unit: 'm' },
    { pattern: /\b(?:centimeter[s]?|centimetre[s]?|cm)\b/i, unit: 'cm' },
    { pattern: /\b(?:millimeter[s]?|millimetre[s]?|mm)\b/i, unit: 'mm' },
    { pattern: /\b(?:yard[s]?|yd)\b/i, unit: 'yd' },
  ];

  // Detect unit
  let detectedUnit: MeasurementUnit = unit; // Default to current unit
  for (const { pattern, unit: u } of unitPatterns) {
    if (pattern.test(normalized)) {
      detectedUnit = u;
      break;
    }
  }

  // Remove unit words for number parsing
  let cleanText = normalized;
  for (const { pattern } of unitPatterns) {
    cleanText = cleanText.replace(pattern, '');
  }
  cleanText = cleanText.trim();

  // Handle compound measurements like "twelve feet six inches"
  // Build readable regex pattern from parts
  const numberPattern = '\\d+(?:\\.\\d+)?';
  const wordNumberPattern =
    '\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\b';
  const valuePattern = `(${numberPattern}|${wordNumberPattern})`;
  const feetPattern = '(?:feet|foot|ft)';
  const inchPattern = '(?:inch(?:es)?|in)';

  const compoundRegex = new RegExp(
    `${valuePattern}\\s*${feetPattern}\\s+(?:and\\s+)?${valuePattern}\\s*${inchPattern}`,
    'i',
  );
  const compoundMatch = normalized.match(compoundRegex);

  if (compoundMatch) {
    let feet =
      parseFloat(compoundMatch[1]) ||
      wordNumbers[compoundMatch[1].toLowerCase()] ||
      0;
    let inches =
      parseFloat(compoundMatch[2]) ||
      wordNumbers[compoundMatch[2].toLowerCase()] ||
      0;
    // Convert to feet (feet + inches/12)
    return { value: feet + inches / 12, unit: 'ft' };
  }

  // Try direct number parse
  const directMatch = cleanText.match(/[\d,.]+/);
  if (directMatch) {
    const direct = parseFloat(directMatch[0].replace(/,/g, ''));
    if (!Number.isNaN(direct)) {
      return { value: direct, unit: detectedUnit };
    }
  }

  // Try word number parsing
  const parts = cleanText.split(/[\s-]+/).filter(Boolean);
  let result = 0;
  let current = 0;
  let hasFraction = false;

  for (const part of parts) {
    const num = wordNumbers[part];
    if (num !== undefined) {
      if (num < 1 && num > 0) {
        // Fraction like "half" or "quarter"
        hasFraction = true;
        current += num;
      } else if (num >= 100) {
        current = current === 0 ? num : current * num;
        if (num >= 1000) {
          result += current;
          current = 0;
        }
      } else {
        current += num;
      }
    } else if (part === 'and' && !hasFraction) {
      // "and" typically precedes fractions or smaller units
      result += current;
      current = 0;
    }
  }

  result += current;
  if (result > 0 || hasFraction) {
    return { value: result, unit: detectedUnit };
  }

  return null;
}

// Register with form context
onMount(() => {
  if (formContext) {
    let rangeDesc = '';
    if (min !== undefined && max !== undefined) {
      rangeDesc = ` (between ${min} and ${max})`;
    } else if (min !== undefined) {
      rangeDesc = ` (minimum ${min})`;
    } else if (max !== undefined) {
      rangeDesc = ` (maximum ${max})`;
    }

    const fieldDef: FieldDefinition = {
      name,
      type: 'measurement',
      label,
      description:
        (description ||
          'A measurement with value and unit (e.g., "12 feet 6 inches")') +
        rangeDesc,
      setValue: (v: unknown) => {
        if (v === null || v === undefined || v === '') {
          updateValue(null);
          return;
        }
        if (typeof v === 'object' && v !== null && 'value' in v) {
          const m = v as MeasurementValue;
          updateValue(m.value, m.unit);
          return;
        }
        if (typeof v === 'number') {
          updateValue(v);
          return;
        }
        // Try to parse spoken measurement
        const parsed = parseSpokenMeasurement(String(v));
        if (parsed) {
          updateValue(parsed.value, parsed.unit);
        }
      },
      getValue: () => (value !== null ? { value, unit } : null),
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
  const val = target.value === '' ? null : parseFloat(target.value);
  updateValue(val);
}

function handleUnitChange(e: Event) {
  const newUnit = (e.target as HTMLSelectElement).value as MeasurementUnit;
  if (value !== null) {
    // Convert value to new unit
    const converted = convert(value, unit, newUnit);
    updateValue(parseFloat(converted.toFixed(4)), newUnit);
  } else {
    unit = newUnit;
  }
}
</script>

<div class="smrt-measurement">
  {#if label}
    <label for={name} class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="input-wrapper" class:smrt-mode={isSmrt}>
    <input
      id={name}
      name={name}
      type="number"
      {placeholder}
      value={value ?? ''}
      {min}
      {max}
      {step}
      {disabled}
      {required}
      class="smrt-input"
      class:invalid={showInvalid}
      oninput={handleInput}
    />

    <select
      name="{name}_unit"
      value={unit}
      {disabled}
      class="unit-select"
      class:smrt-mode={isSmrt}
      onchange={handleUnitChange}
    >
      {#each units as u (u)}
        <option value={u}>{unitAbbreviations[u]} ({unitLabels[u]})</option>
      {/each}
    </select>
  </div>

  <!-- Hidden input for combined value -->
  <input type="hidden" name="{name}_combined" value={value !== null ? `${value} ${unit}` : ''} />

  {#if error}
    <div class="validation-error">{error}</div>
  {:else if showInvalid && !isInRange}
    <div class="validation-error">
      {#if min !== undefined && value !== null && value < min}
        Value must be at least {min} {unitAbbreviations[unit]}
      {:else if max !== undefined && value !== null && value > max}
        Value must be at most {max} {unitAbbreviations[unit]}
      {/if}
    </div>
  {/if}
</div>

<style>
  .smrt-measurement {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .smrt-label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface, #374151);
  }

  .smrt-label .required {
    color: var(--smrt-color-error, #ba1a1a);
    margin-left: 2px;
  }

  .input-wrapper {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
  }

  .input-wrapper.smrt-mode {
    border: 1px solid var(--smrt-color-tertiary, #6b5778);
    border-radius: var(--smrt-radius-small, 6px);
    padding: var(--smrt-spacing-1, 2px);
    background: var(--smrt-color-tertiary-container, #f3e5f5);
  }

  .smrt-input {
    flex: 1;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 6px);
    background: var(--smrt-color-surface, #fff);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
    min-width: 0;
  }

  .input-wrapper.smrt-mode .smrt-input {
    border: none;
    background: transparent;
  }

  .smrt-input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
  }

  .input-wrapper.smrt-mode .smrt-input:focus {
    box-shadow: none;
  }

  .smrt-input:disabled {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    cursor: not-allowed;
  }

  .smrt-input.invalid {
    border-color: var(--smrt-color-error, #ba1a1a);
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

  .unit-select {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 6px);
    background: var(--smrt-color-surface, #fff);
    cursor: pointer;
    min-width: 100px;
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .unit-select.smrt-mode {
    border: none;
    background: transparent;
  }

  .unit-select:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
  }

  .unit-select.smrt-mode:focus {
    box-shadow: none;
  }

  .unit-select:disabled {
    background: #f3f4f6;
    cursor: not-allowed;
  }

  .validation-error {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-error, #ba1a1a);
    margin-top: 4px;
  }
</style>
