<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { parseSpokenBoolean } from '../../utils/forms/formatters.js';

export interface Props {
  /** Field name */
  name: string;
  /** Field label */
  label?: string;
  /** Description for voice extraction */
  description?: string;
  /** Current value (bindable) */
  checked?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Called when value changes */
  onchange?: (checked: boolean) => void;
}

let {
  name,
  label,
  description,
  checked = $bindable(false),
  disabled = false,
  required = false,
  onchange,
}: Props = $props();

const app = useAppState();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

function updateValue(newValue: boolean) {
  checked = newValue;
  onchange?.(checked);
}

// Register with form context
onMount(() => {
  if (formContext) {
    const fieldDef: FieldDefinition = {
      name,
      type: 'checkbox',
      label,
      description: description || `Yes or no for ${label || name}`,
      setValue: (v: unknown) => {
        if (typeof v === 'boolean') {
          updateValue(v);
          return;
        }
        const parsed = parseSpokenBoolean(String(v ?? ''));
        if (parsed !== null) {
          updateValue(parsed);
        }
      },
      getValue: () => checked,
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
  const target = e.target as HTMLInputElement;
  updateValue(target.checked);
}
</script>

<div class="smrt-checkbox-field" class:disabled class:smrt-mode={isSmrt}>
  <div class="container" use:ripple>
    <input
      type="checkbox"
      id={name}
      {name}
      {checked}
      {disabled}
      {required}
      class="input"
      onchange={handleChange}
    />
    <div class="checkbox" class:checked>
      {#if checked}
        <svg viewBox="0 0 24 24" class="icon">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
        </svg>
      {/if}
    </div>
    <div class="state-layer"></div>
  </div>
  
  {#if label}
    <label for={name} class="label">
      {label}{#if required}*{/if}
    </label>
  {/if}
</div>

<style>
  .smrt-checkbox-field {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    cursor: pointer;
    vertical-align: middle;
    user-select: none;
  }

  .container {
    position: relative;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--smrt-radius-full, 9999px);
    margin: -10px; /* Offset the 40x40 container to align 18x18 checkbox */
  }

  .input {
    position: absolute;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: inherit;
    z-index: 1;
    margin: 0;
  }

  .checkbox {
    width: 18px;
    height: 18px;
    border: 2px solid var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-sm, 4px);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
    background-color: transparent;
  }

  .checkbox.checked {
    background-color: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }

  /* Smrt mode styling */
  .smrt-mode .checkbox.checked {
    background-color: var(--smrt-color-tertiary);
    border-color: var(--smrt-color-tertiary);
  }

  .icon {
    width: 14px;
    height: 14px;
    fill: var(--smrt-color-on-primary);
  }

  .smrt-mode .icon {
    fill: var(--smrt-color-on-tertiary);
  }

  .label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
    cursor: inherit;
  }

  .disabled {
    opacity: 0.38;
    pointer-events: none;
  }

  .input:focus-visible ~ .state-layer {
    background-color: var(--smrt-color-on-surface);
    opacity: 0.12;
  }

  .state-layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    border-radius: var(--smrt-radius-full, 9999px);
    pointer-events: none;
    transition: opacity var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, ease);
  }

  .container:hover .state-layer {
    background-color: var(--smrt-color-on-surface);
    opacity: 0.08;
  }
</style>