<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { matchOption } from '../../utils/forms/formatters.js';
import { Icon } from '../display/index.js';
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

let isFocused = $state(false);
const isSmrt = $derived(app.state.mode === 'smrt');

// Helper to update value
function updateValue(newValue: string) {
  value = newValue;
  onchange?.(value);
}

// Register with form context
onMount(() => {
  if (formContext) {
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
        const matched = matchOption(strVal, options);
        if (matched) {
          updateValue(matched);
        } else if (options.some((o) => o.value === strVal)) {
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

<div 
  class="smrt-select-field" 
  class:smrt-mode={isSmrt} 
  class:focused={isFocused} 
  class:disabled
  class:has-value={!!value}
>
  <div class="container">
    <div class="content">
      {#if label}
        <label for={name} class="label">
          {label}{#if required}*{/if}
        </label>
      {/if}
      <select
        id={name}
        {name}
        {value}
        {disabled}
        {required}
        class="input"
        onchange={handleChange}
        onfocus={() => isFocused = true}
        onblur={() => isFocused = false}
      >
        <option value="" disabled selected={!value}>{placeholder}</option>
        {#each options as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </div>

    <div class="trailing-icon">
      <Icon name="chevron-down" size={24} />
    </div>

    <div class="active-indicator"></div>
  </div>

  {#if description && isFocused}
    <div class="supporting-text">
      <span class="info">{description}</span>
    </div>
  {/if}
</div>

<style>
  .smrt-select-field {
    --field-color: var(--md-sys-color-on-surface-variant);
    --field-bg: var(--md-sys-color-surface-container-highest);
    --field-active: var(--md-sys-color-primary);
    
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 240px;
  }

  .container {
    position: relative;
    display: flex;
    align-items: center;
    background-color: var(--field-bg);
    border-radius: 4px 4px 0 0;
    min-height: 56px;
    padding: 0 16px;
    transition: background-color 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  .container:hover {
    background-color: var(--md-sys-color-surface-container-high);
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 100%;
    padding-top: 8px;
  }

  .label {
    font-size: 1rem;
    line-height: 1.5;
    letter-spacing: 0.5px;
    color: var(--field-color);
    pointer-events: none;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    transform-origin: top left;
  }

  .focused .label, .has-value .label {
    transform: translateY(-8px) scale(0.75);
    color: var(--field-active);
  }

  .input {
    border: none;
    background: transparent;
    font-size: 1rem;
    line-height: 1.5;
    letter-spacing: 0.5px;
    color: var(--md-sys-color-on-surface);
    width: 100%;
    padding: 0;
    margin: 0;
    height: 24px;
    appearance: none;
    cursor: pointer;
  }

  .input:focus {
    outline: none;
  }

  .trailing-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--field-color);
    pointer-events: none;
    margin-right: -4px;
  }

  .active-indicator {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 1px;
    background-color: var(--field-color);
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  .focused .active-indicator {
    height: 2px;
    background-color: var(--field-active);
  }

  .supporting-text {
    padding: 4px 16px 0;
    font-size: 0.75rem;
  }

  .info { color: var(--md-sys-color-on-surface-variant); }

  .disabled {
    opacity: 0.38;
    pointer-events: none;
  }

  /* Smrt mode overrides */
  .smrt-mode {
    --field-active: var(--md-sys-color-tertiary);
  }
</style>