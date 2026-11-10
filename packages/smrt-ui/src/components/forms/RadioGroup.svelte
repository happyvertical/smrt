<script lang="ts">
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import { highlightControl, revealControl } from './control-dom.js';
import type {
  ControlInteractionOptions,
  ControlOption,
} from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import {
  prepareEnabledOptionValue,
  validatesEnabledOption,
} from './control-value-validation.js';
import { setRadioGroupContext } from './radio-group-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';
export interface Props {
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
  /** Identifier for this radio group and its form field. */
  name: string;
  /** The currently selected option value. */
  value?: string;
  /** Legend text displayed above the radio options. */
  label?: string;
  /** Explanatory text shown below the label. */
  description?: string;
  /** Validation error message to display. */
  error?: string;
  /** Blocks interaction and submission of this control. */
  disabled?: boolean;
  /** Makes selecting an option mandatory for validation. */
  required?: boolean;
  /** Registers this control for agent interaction; omit or pass false to exclude. */
  interaction?: ControlInteractionOptions | false;
  /** Fired when the selected option value changes. */
  onvaluechange?: (value: string) => void;
  /** The RadioOption components to display. */
  children: Snippet;
  /** Additional CSS class names. */
  class?: string;
}
let {
  name,
  value = $bindable(''),
  label,
  description,
  error,
  disabled = false,
  required = false,
  interaction,
  onvaluechange,
  children,
  class: className = '',
  density,
}: Props = $props();
const interactionContext = tryGetControlInteractionContext();
let fieldsetEl = $state<HTMLFieldSetElement | null>(null);
let options = $state<ControlOption[]>([]);
function setValue(next: string) {
  value = next;
  onvaluechange?.(next);
}
setRadioGroupContext({
  get name() {
    return name;
  },
  get value() {
    return value;
  },
  get disabled() {
    return disabled;
  },
  get required() {
    return required;
  },
  setValue,
  registerOption(option) {
    return untrack(() => {
      options = [
        ...options.filter((item) => item.value !== option.value),
        option,
      ];
      return () => {
        untrack(() => {
          options = options.filter((item) => item.value !== option.value);
        });
      };
    });
  },
});
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name),
);
useControlRegistration(() => {
  const element = fieldsetEl;
  if (!element || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'radio-group',
      label,
      description: interaction?.description ?? description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
      constraints: { required },
      options,
    },
    getValue: () => value,
    prepareValue: (next) => String(prepareEnabledOptionValue(options, next)),
    setValue: (next) => {
      const candidate = String(next);
      if (
        options.some(
          (option) => String(option.value) === candidate && !option.disabled,
        )
      )
        setValue(candidate);
    },
    clear: () => {
      setValue('');
      return true;
    },
    focus: () =>
      element.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus(),
    reveal: () => revealControl(element),
    highlight: (durationMs) => highlightControl(element, durationMs),
    validate: () => element.reportValidity(),
    validateValue: (next) => validatesEnabledOption(options, next),
    getState: () => ({
      disabled: element.matches(':disabled'),
      valid: !required || !!value,
      validationMessage: error,
    }),
  };
});
</script>
<fieldset bind:this={fieldsetEl} data-density={density} class="smrt-radio-group__root {className}" {disabled}
  aria-describedby={description ? `${name}-description` : undefined} data-smrt-control={controlId} data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id} data-smrt-component="RadioGroup">
  {#if label}<legend>{label}{#if required}<span aria-hidden="true"> *</span>{/if}</legend>{/if}
  {#if description}<p id={`${name}-description`} class="smrt-radio-group__description" data-smrt-part="description">{description}</p>{/if}
  <div class="smrt-radio-group__options" data-smrt-part="options">{@render children()}</div>
  {#if error}<p class="smrt-radio-group__error" data-smrt-part="error" role="alert">{error}</p>{/if}
</fieldset>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-radio-group__root {
    margin: 0;
    padding: 0;
  }
  legend {
    margin-bottom: var(--smrt-spacing-2);
  }
  .smrt-radio-group__description, .smrt-radio-group__error {
    margin: var(--smrt-spacing-1) 0 var(--smrt-spacing-2);
  }
  .smrt-radio-group__options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
  }
  .smrt-radio-group__root[data-density='touch'] {
    --smrt-control-target-min: var(--smrt-touch-target-min);
  }
  .smrt-radio-group__root[data-density='comfortable'] {
    --smrt-control-target-min: 0px;
  }
}

@layer smrt.theme {
  .smrt-radio-group__root {
    border: 0;
    color: var(--smrt-color-on-surface);
  }
  legend {
    font: var(--smrt-typography-label-large-font);
  }
  .smrt-radio-group__description, .smrt-radio-group__error {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-radio-group__error {
    color: var(--smrt-color-error);
  }
  :global(.smrt-radio-group__root[data-smrt-highlighted='true']) {
    outline: 3px solid var(--smrt-color-tertiary);
    outline-offset: 4px;
    border-radius: var(--smrt-radius-small);
  }
}

</style>
