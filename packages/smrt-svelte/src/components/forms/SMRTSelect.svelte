<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import type { SelectOption } from './types.js';

interface Props {
  /** Field name */
  name: string;
  /** Field label */
  label?: string;
  /** Description for voice extraction */
  description?: string;
  /** Available options */
  options: SelectOption[];
  /** Placeholder text */
  placeholder?: string;
  /** Current value (bindable) */
  value?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Called when value changes */
  onchange?: (value: string) => void;
}

let {
  name,
  label,
  description,
  options,
  placeholder = 'Select an option...',
  value = $bindable(''),
  disabled = false,
  required = false,
  onchange,
}: Props = $props();

const app = useAppState();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

// Helper to update value
function updateValue(newValue: string) {
  value = newValue;
  onchange?.(value);
}

// Find option by fuzzy matching spoken text
function matchOption(spokenText: string): string | null {
  const normalized = spokenText.toLowerCase().trim();

  // Try exact match first
  for (const opt of options) {
    if (
      opt.value.toLowerCase() === normalized ||
      opt.label.toLowerCase() === normalized
    ) {
      return opt.value;
    }
  }

  // Try partial match
  for (const opt of options) {
    if (
      opt.label.toLowerCase().includes(normalized) ||
      normalized.includes(opt.label.toLowerCase())
    ) {
      return opt.value;
    }
  }

  return null;
}

// Register with form context
onMount(() => {
  if (formContext) {
    // Build description with options for better voice extraction
    const optionsDesc = options.map((o) => o.label).join(', ');
    const fullDescription = description
      ? `${description}. Options: ${optionsDesc}`
      : `Options: ${optionsDesc}`;

    const fieldDef: FieldDefinition = {
      name,
      type: 'select',
      label,
      description: fullDescription,
      setValue: (v: unknown) => {
        const strVal = String(v ?? '');
        // Try to match the spoken value to an option
        const matched = matchOption(strVal);
        if (matched) {
          updateValue(matched);
        } else if (options.some((o) => o.value === strVal)) {
          // Direct value match
          updateValue(strVal);
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

function handleChange(e: Event) {
  const target = e.target as HTMLSelectElement;
  updateValue(target.value);
}
</script>

<div class="smrt-select">
  {#if label}
    <label for={name} class="smrt-label">
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="select-wrapper">
    <select
      id={name}
      {name}
      {value}
      {disabled}
      {required}
      class="smrt-select-input"
      class:smrt-mode={isSmrt}
      onchange={handleChange}
    >
      <option value="" disabled>{placeholder}</option>
      {#each options as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>

    <svg class="select-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M6 9l6 6 6-6"/>
    </svg>
  </div>
</div>

<style>
  .smrt-select {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .smrt-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  .smrt-label .required {
    color: #ef4444;
    margin-left: 2px;
  }

  .select-wrapper {
    position: relative;
    display: flex;
  }

  .smrt-select-input {
    flex: 1;
    padding: 8px 36px 8px 12px;
    font-size: 1rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    appearance: none;
    cursor: pointer;
    transition: all 0.2s;
  }

  .smrt-select-input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .smrt-select-input:disabled {
    background: #f3f4f6;
    cursor: not-allowed;
  }

  .smrt-select-input.smrt-mode {
    border-color: #a855f7;
  }

  .select-arrow {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: #6b7280;
    pointer-events: none;
  }
</style>
