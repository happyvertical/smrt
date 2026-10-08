<script lang="ts">
import { Icon } from '@happyvertical/smrt-ui';
import { FieldLabel } from '@happyvertical/smrt-ui/forms';
import { matchOption } from '@happyvertical/smrt-ui/utils/forms/formatters.js';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { prepareTextFieldValue } from './prepare-field-value.js';
import type { SelectOption } from './types.js';

export interface Props {
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

// Unique per instance: the control stays labelled even if `name` repeats on a page.
const uid = $props.id();
const labelId = `${uid}-label`;

const app = useAppState();
const formContext = tryGetFormContext();

let isFocused = $state(false);
/** A caller-supplied empty choice replaces the placeholder: one empty option only. */
const hasEmptyOption = $derived(options.some((o) => o.value === ''));
// Options are keyed by value: a repeated value (e.g. two empty choices) would
// throw each_key_duplicate and take the whole form down, so keep the first.
const uniqueOptions = $derived(
  options.filter(
    (option, index) =>
      options.findIndex((o) => o.value === option.value) === index,
  ),
);
const isSmrt = $derived(app.state.mode === 'smrt');

// Helper to update value
function updateValue(newValue: string) {
  value = newValue;
  onchange?.(value);
}

// Register with form context
$effect(() => {
  if (formContext) {
    const registeredName = name;
    const fieldDef: FieldDefinition = {
      name: registeredName,
      type: 'select',
      get label() {
        return label;
      },
      get description() {
        const optionsDescription = options.map((o) => o.label).join(', ');
        return description
          ? `${description}. Options: ${optionsDescription}`
          : `Options: ${optionsDescription}`;
      },
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
      prepareValue: (candidate) => {
        const next = prepareTextFieldValue(candidate);
        if (next.trim() === '') return next;
        return matchOption(next, options) ?? next;
      },
      clear: () => {
        updateValue('');
        return true;
      },
      getState: () => ({ disabled }),
      get constraints() {
        return { required };
      },
      get options() {
        return options.map((option) => ({
          value: option.value,
          label: option.label,
        }));
      },
      validateValue: (candidate) => {
        const next = String(candidate ?? '');
        if (next === '') return !required;
        return options.some((option) => option.value === next);
      },
      validate: () => !required || value.trim().length > 0,
    };
    return formContext.registerField(fieldDef);
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
  {#if label}
    <FieldLabel id={labelId} for={name} {label} {required} />
  {/if}
  <div class="container">
    <div class="content">
      <select
        id={name}
        aria-labelledby={label ? labelId : undefined}
        {name}
        {value}
        {disabled}
        {required}
        class="input"
        aria-describedby={`${name}-supporting`}
        onchange={handleChange}
        onfocus={() => isFocused = true}
        onblur={() => isFocused = false}
      >
        {#if !hasEmptyOption}
          <option value="" disabled selected={!value}>{placeholder}</option>
        {/if}
        {#each uniqueOptions as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </div>

    <div class="trailing-icon">
      <Icon name="chevron-down" size={24} />
    </div>

    <div class="active-indicator"></div>
  </div>

  <div id={`${name}-supporting`} class="supporting-text" aria-live="polite">
    {#if description && isFocused}
      <span class="info">{description}</span>
    {/if}
  </div>
</div>

<style>
  .smrt-select-field {
    --field-color: var(--smrt-color-on-surface-variant);
    --field-bg: var(--smrt-color-surface-container-highest);
    --field-active: var(--smrt-color-primary);
    
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
  }

  .container {
    position: relative;
    display: flex;
    align-items: center;
    background-color: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 6px);
    min-height: 40px;
    padding: 0 var(--smrt-spacing-3, 12px);
    transition: background-color var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
  }

  .container:hover {
    background-color: var(--smrt-color-surface-container-high);
  }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 100%;
      }


  .input {
    border: none;
    background: transparent;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    letter-spacing: var(--smrt-typography-body-large-tracking, 0.5px);
    color: var(--smrt-color-on-surface);
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

  .active-indicator { display: none; }

  .focused .container {
    border-color: var(--field-active);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--field-active) 10%, transparent);
  }

  .supporting-text {
    padding: var(--smrt-spacing-1, 4px) 0 0;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .info { color: var(--smrt-color-on-surface-variant); }

  .disabled {
    opacity: 0.38;
    pointer-events: none;
  }

  /* Smrt mode overrides */
  .smrt-mode {
    --field-active: var(--smrt-color-tertiary);
  }
</style>
