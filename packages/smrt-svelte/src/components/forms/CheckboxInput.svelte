<script lang="ts">
import { ripple } from '@happyvertical/smrt-ui';
import { parseSpokenBoolean } from '@happyvertical/smrt-ui/utils/forms/formatters.js';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import { invalidStagedValue } from './prepare-field-value.js';

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
$effect(() => {
  if (formContext) {
    const registeredName = name;
    const fieldDef: FieldDefinition = {
      name: registeredName,
      type: 'checkbox',
      get label() {
        return label;
      },
      get description() {
        return description || `Yes or no for ${label || name}`;
      },
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
      prepareValue: (candidate) => {
        if (typeof candidate === 'boolean') return candidate;
        if (
          candidate !== null &&
          candidate !== undefined &&
          typeof candidate !== 'string' &&
          typeof candidate !== 'number'
        ) {
          return invalidStagedValue();
        }
        return (
          parseSpokenBoolean(String(candidate ?? '')) ?? invalidStagedValue()
        );
      },
      clear: () => {
        updateValue(false);
        return true;
      },
      getState: () => ({ disabled }),
      get constraints() {
        return { required };
      },
      validateValue: (candidate) => {
        const next =
          typeof candidate === 'boolean'
            ? candidate
            : parseSpokenBoolean(String(candidate ?? ''));
        return next !== null && (!required || next);
      },
      validate: () => !required || checked,
    };
    return formContext.registerField(fieldDef);
  }
});

function handleChange(e: Event) {
  const target = e.target as HTMLInputElement;
  updateValue(target.checked);
}
</script>

<div class="smrt-checkbox-input__root" class:smrt-checkbox-input__disabled={disabled} class:smrt-checkbox-input__mode={isSmrt} data-smrt-component="CheckboxInput">
  <div class="smrt-checkbox-input__container" use:ripple>
    <input
      type="checkbox"
      id={name}
      {name}
      {checked}
      {disabled}
      {required}
      class="smrt-checkbox-input__input"
      data-smrt-part="input"
      onchange={handleChange}
    />
    <div class="smrt-checkbox-input__box" class:smrt-checkbox-input__checked={checked} data-smrt-part="box">
      {#if checked}
        <svg viewBox="0 0 24 24" class="smrt-checkbox-input__icon">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
        </svg>
      {/if}
    </div>
    <div class="smrt-checkbox-input__state-layer"></div>
  </div>
  
  {#if label}
    <label for={name} class="smrt-checkbox-input__label" data-smrt-part="label">
      {label}{#if required}*{/if}
    </label>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-checkbox-input__root {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: var(--smrt-spacing-2);
    cursor: pointer;
    user-select: none;
  }
  .smrt-checkbox-input__container {
    position: relative;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: -10px;
  }
  .smrt-checkbox-input__input {
    position: absolute;
    width: 100%;
    height: 100%;
    cursor: inherit;
    z-index: 1;
    margin: 0;
    opacity: 0;
  }
  .smrt-checkbox-input__box {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-checkbox-input__icon {
    width: 14px;
    height: 14px;
  }
  .smrt-checkbox-input__label {
    cursor: inherit;
  }
  .smrt-checkbox-input__state-layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
  }
  .smrt-checkbox-input__disabled {
    pointer-events: none;
  }
}

@layer smrt.theme {
  .smrt-checkbox-input__root {
    vertical-align: middle;
  }
  .smrt-checkbox-input__container {
    border-radius: var(--smrt-radius-full);
    /* Offset the 40x40 container to align 18x18 checkbox */
  }
  .smrt-checkbox-input__box {
    border: 2px solid var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-sm);
    transition: all var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
    background-color: transparent;
  }
  .smrt-checkbox-input__box.smrt-checkbox-input__checked {
    background-color: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }
  /* Smrt mode styling */
  .smrt-checkbox-input__mode .smrt-checkbox-input__box.smrt-checkbox-input__checked {
    background-color: var(--smrt-color-tertiary);
    border-color: var(--smrt-color-tertiary);
  }
  .smrt-checkbox-input__icon {
    fill: var(--smrt-color-on-primary);
  }
  .smrt-checkbox-input__mode .smrt-checkbox-input__icon {
    fill: var(--smrt-color-on-tertiary);
  }
  .smrt-checkbox-input__label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-checkbox-input__disabled {
    opacity: 0.38;
  }
  .smrt-checkbox-input__input:focus-visible ~ .smrt-checkbox-input__state-layer {
    background-color: var(--smrt-color-on-surface);
    opacity: 0.12;
  }
  .smrt-checkbox-input__state-layer {
    border-radius: var(--smrt-radius-full);
    transition: opacity var(--smrt-duration-short3, 200ms) var(--smrt-easing-standard, ease);
  }
  .smrt-checkbox-input__container:hover .smrt-checkbox-input__state-layer {
    background-color: var(--smrt-color-on-surface);
    opacity: 0.08;
  }
}

</style>
