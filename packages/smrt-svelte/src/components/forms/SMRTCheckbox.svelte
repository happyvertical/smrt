<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';

interface Props {
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

// Parse spoken boolean value
function parseSpokenBoolean(text: string): boolean | null {
  const normalized = text.toLowerCase().trim();

  const trueWords = [
    'yes',
    'yeah',
    'yep',
    'true',
    'correct',
    'affirmative',
    'check',
    'checked',
    'on',
    'enable',
    'enabled',
  ];
  const falseWords = [
    'no',
    'nope',
    'false',
    'incorrect',
    'negative',
    'uncheck',
    'unchecked',
    'off',
    'disable',
    'disabled',
  ];

  for (const word of trueWords) {
    if (normalized.includes(word)) return true;
  }

  for (const word of falseWords) {
    if (normalized.includes(word)) return false;
  }

  return null;
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

<div class="smrt-checkbox">
  <label class="checkbox-label" class:disabled>
    <input
      type="checkbox"
      id={name}
      {name}
      {checked}
      {disabled}
      {required}
      class="checkbox-input"
      class:smrt-mode={isSmrt}
      onchange={handleChange}
    />
    <span class="checkbox-custom" class:checked class:smrt-mode={isSmrt}>
      {#if checked}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      {/if}
    </span>
    {#if label}
      <span class="label-text">
        {label}
        {#if required}<span class="required">*</span>{/if}
      </span>
    {/if}
  </label>
</div>

<style>
  .smrt-checkbox {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
  }

  .checkbox-label.disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .checkbox-input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .checkbox-custom {
    width: 20px;
    height: 20px;
    border: 2px solid #d1d5db;
    border-radius: 4px;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .checkbox-custom.checked {
    background: #3b82f6;
    border-color: #3b82f6;
    color: white;
  }

  .checkbox-custom.smrt-mode {
    border-color: #a855f7;
  }

  .checkbox-custom.smrt-mode.checked {
    background: #a855f7;
    border-color: #a855f7;
  }

  .checkbox-input:focus + .checkbox-custom {
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .checkbox-input:focus + .checkbox-custom.smrt-mode {
    box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.1);
  }

  .label-text {
    font-size: 0.875rem;
    color: #374151;
  }

  .label-text .required {
    color: #ef4444;
    margin-left: 2px;
  }
</style>
