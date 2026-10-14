<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLSelectAttributes } from 'svelte/elements';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { prepareTextControlValue } from './control-value-validation.js';
import { tryGetFormGroupContext } from './form-group-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props extends Omit<HTMLSelectAttributes, 'class' | 'value'> {
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
  /** The currently selected option value. */
  value?: string;
  /** Additional CSS class names. */
  class?: string;
  /** Registers this control for agent interaction; omit or pass false to exclude. */
  interaction?: ControlInteractionOptions | false;
  /** The option and optgroup elements. */
  children: Snippet;
}

let {
  id,
  value = $bindable(''),
  disabled = false,
  required = false,
  name,
  class: className = '',
  interaction,
  children,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
  density,
  ...rest
}: Props = $props();

// Inherit id / hint+error association / error state from a wrapping FormGroup.
const formGroup = tryGetFormGroupContext();
const controlInteraction = tryGetControlInteractionContext();
let selectEl = $state<HTMLSelectElement | null>(null);
const resolvedId = $derived(id ?? formGroup?.().inputId);
const resolvedDescribedBy = $derived(
  ariaDescribedby ?? formGroup?.().describedBy,
);
const resolvedInvalid = $derived(
  ariaInvalid ?? (formGroup?.().invalid ? 'true' : undefined),
);
const resolvedInteraction = $derived.by(() => {
  const inherited = formGroup?.().interaction;
  if (interaction === false || inherited === false) return false;
  return { ...(inherited ?? {}), ...(interaction ?? {}) };
});
const resolvedControlId = $derived(
  resolvedInteraction === false
    ? undefined
    : (resolvedInteraction.id ?? name ?? resolvedId),
);

function setControlValue(next: unknown) {
  value = String(next ?? '');
  if (selectEl) emitControlChange(selectEl);
}

function isOptionDisabled(option: HTMLOptionElement) {
  return option.disabled || option.closest('optgroup')?.disabled === true;
}

function validateControlValue(next: unknown) {
  const element = selectEl;
  if (!element) return true;
  const candidate = String(next ?? '');
  if (candidate === '') return !required;
  return Array.from(element.options).some(
    (option) => option.value === candidate && !isOptionDisabled(option),
  );
}

useControlRegistration(() => {
  const element = selectEl;
  const controlId = resolvedControlId;
  const options = resolvedInteraction;
  if (!element || !controlId || options === false) return false;
  return {
    controlId,
    subject: options.subject,
    metadata: {
      kind: 'select',
      label: formGroup?.().label ?? ariaLabel ?? undefined,
      description: options.description ?? formGroup?.().description,
      sensitivity: options.sensitivity ?? 'public',
      readable: options.readable,
      writable: options.writable,
      constraints: { required: required === true },
      options: Array.from(element.options).map((option) => ({
        value: option.value,
        label: option.label,
        disabled: isOptionDisabled(option),
      })),
    },
    getValue: () => value,
    prepareValue: prepareTextControlValue,
    setValue: setControlValue,
    clear: () => {
      setControlValue('');
      return true;
    },
    focus: () => element.focus(),
    reveal: () => revealControl(element),
    highlight: (durationMs) => highlightControl(element, durationMs),
    validate: () => element.reportValidity(),
    validateValue: validateControlValue,
    getState: () => ({
      disabled: element.matches(':disabled'),
      valid: element.validity.valid,
      validationMessage: element.validationMessage || undefined,
    }),
  };
});

export function focus(): void {
  selectEl?.focus();
}

export function getElement(): HTMLSelectElement | null {
  return selectEl;
}
</script>

	<select
		bind:this={selectEl}
	id={resolvedId}
	bind:value
	{disabled}
	{required}
		{name}
		aria-label={ariaLabel}
	aria-describedby={resolvedDescribedBy}
	aria-invalid={resolvedInvalid}
		data-density={density} class="smrt-select__root {className}"
		data-smrt-control={resolvedControlId}
		data-smrt-form={controlInteraction?.formId}
		data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
		data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}
	{...rest} data-smrt-component="Select"
>
	{@render children()}
</select>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-select__root {
    box-sizing: border-box;
    display: block;
    width: 100%;
    padding: 0.5rem 2rem 0.5rem 0.75rem;
    cursor: pointer;
  }
  .smrt-select__root:disabled {
    cursor: not-allowed;
  }
  @media (max-width: 48rem) {
    .smrt-select__root {
      min-height: 2.75rem;
    }
  }
  .smrt-select__root[data-density='touch'] {
    --smrt-select-target-min: var(--smrt-touch-target-min);
  }
  .smrt-select__root[data-density='comfortable'] {
    --smrt-select-target-min: 0px;
  }
  .smrt-select__root {
    min-height: max(var(--smrt-control-height), var(--smrt-select-target-min, var(--smrt-control-target-min)));
  }
}
@layer smrt.theme {
  .smrt-select__root {
    font-size: var(--smrt-typography-body-medium-size);
    line-height: var(--smrt-typography-body-medium-line-height);
    color: var(--smrt-color-on-surface);
    background-color: var(--smrt-surface-control);
    font-weight: var(--smrt-control-weight);
    background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%2379747e' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
    background-position: right 0.5rem center;
    background-repeat: no-repeat;
    background-size: 1.5em 1.5em;
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-control-radius);
    appearance: none;
    transition: border-color 0.15s ease-in-out,
			box-shadow 0.15s ease-in-out;
  }
  .smrt-select__root:focus {
    border-color: var(--smrt-color-primary);
  }
  .smrt-select__root:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-select__root[data-smrt-highlighted='true'] {
    outline: 3px solid var(--smrt-color-tertiary);
    outline-offset: 3px;
  }
  .smrt-select__root:disabled {
    background-color: var(--smrt-color-surface-container-high);
    opacity: var(--smrt-state-disabled);
  }
  @media (max-width: 48rem) {
    .smrt-select__root {
      font-size: max(var(--smrt-typography-body-medium-size), 16px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-select__root {
      transition: none;
    }
  }
}
</style>
