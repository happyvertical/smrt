<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type {
  ControlInteractionOptions,
  ControlKind,
} from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import {
  prepareNumberControlValue,
  prepareTextControlValue,
} from './control-value-validation.js';
import { tryGetFormGroupContext } from './form-group-context.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props extends Omit<HTMLInputAttributes, 'class' | 'value'> {
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
  /** Input value as string or number (bindable). */
  value?: string | number;
  /** CSS class to apply to the input element. */
  class?: string;
  /** Stable identity and sensitivity metadata for interaction adapters. */
  interaction?: ControlInteractionOptions | false;
}

let {
  id,
  type = 'text',
  value = $bindable(''),
  placeholder,
  disabled = false,
  readonly = false,
  required = false,
  name,
  class: className = '',
  interaction,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
  density,
  ...rest
}: Props = $props();

// When wrapped in a <FormGroup>, inherit the id (so its <label for> resolves),
// the hint/error association, and the error state — unless set explicitly.
const formGroup = tryGetFormGroupContext();
const controlInteraction = tryGetControlInteractionContext();
let inputEl = $state<HTMLInputElement | null>(null);
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

function kindFromType(): ControlKind {
  switch (type) {
    case 'email':
      return 'email';
    case 'password':
      return 'password';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime-local':
      return 'datetime';
    case 'range':
      return 'slider';
    default:
      return 'text';
  }
}

function setControlValue(next: unknown) {
  value =
    type === 'number' || type === 'range'
      ? next === '' || next === null || next === undefined
        ? ''
        : Number(next)
      : String(next ?? '');
  if (inputEl) emitControlChange(inputEl);
}

function validateControlValue(next: unknown) {
  if (!inputEl) return true;
  if (
    (type === 'number' || type === 'range') &&
    next !== '' &&
    next !== null &&
    next !== undefined &&
    !Number.isFinite(typeof next === 'number' ? next : Number(next))
  ) {
    return { valid: false, message: 'invalid_number' };
  }
  const candidate = inputEl.cloneNode() as HTMLInputElement;
  const proposedValue = String(next ?? '');
  try {
    candidate.value = proposedValue;
  } catch {
    return { valid: false, message: 'invalid_value' };
  }
  // Native inputs sanitize some assignments without making them invalid: an
  // optional invalid date/time becomes empty and a range value can clamp to a
  // bound. A staged proposal must never be marked applicable when the setter
  // would apply a different value than the one reviewed.
  if (candidate.value !== proposedValue) {
    return { valid: false, message: 'invalid_value' };
  }
  return {
    valid: candidate.checkValidity(),
    message: candidate.validationMessage || undefined,
  };
}

useControlRegistration(() => {
  const element = inputEl;
  const controlId = resolvedControlId;
  const options = resolvedInteraction;
  if (!element || !controlId || options === false) return false;

  return {
    controlId,
    subject: options.subject,
    metadata: {
      kind: kindFromType(),
      label: formGroup?.().label ?? ariaLabel ?? undefined,
      description: options.description ?? formGroup?.().description,
      sensitivity:
        options.sensitivity ?? (type === 'password' ? 'secret' : 'public'),
      readable: options.readable,
      writable: options.writable,
      constraints: {
        required: required === true,
        min: element.min || undefined,
        max: element.max || undefined,
        step: element.step || undefined,
        minLength: element.minLength >= 0 ? element.minLength : undefined,
        maxLength: element.maxLength >= 0 ? element.maxLength : undefined,
        pattern: element.pattern || undefined,
      },
    },
    getValue: () => value,
    prepareValue: (next) =>
      type === 'number' || type === 'range'
        ? prepareNumberControlValue(next)
        : prepareTextControlValue(next),
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
      readonly: element.readOnly,
      valid: element.validity.valid,
      validationMessage: element.validationMessage || undefined,
    }),
  };
});

export function focus(): void {
  inputEl?.focus();
}

export function reveal(): void {
  if (inputEl) revealControl(inputEl);
}

export function highlight(durationMs?: number): void {
  if (inputEl) highlightControl(inputEl, durationMs);
}

export function getElement(): HTMLInputElement | null {
  return inputEl;
}
</script>

<input
	bind:this={inputEl}
	id={resolvedId}
	{type}
	bind:value
	{placeholder}
	{disabled}
	{readonly}
	{required}
	{name}
	aria-label={ariaLabel}
	aria-describedby={resolvedDescribedBy}
	aria-invalid={resolvedInvalid}
	data-density={density} class="smrt-input__root {className}"
	data-smrt-control={resolvedControlId}
	data-smrt-form={controlInteraction?.formId}
	data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
	data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}
	{...rest} data-smrt-component="Input"
/>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-input__root {
    box-sizing: border-box;
    display: block;
    width: 100%;
    padding: 0.5rem 0.75rem;
  }
  .smrt-input__root:disabled {
    cursor: not-allowed;
  }
  @media (max-width: 48rem) {
    .smrt-input__root {
      min-height: 2.75rem;
    }
  }
  .smrt-input__root[data-density='touch'] {
    --smrt-input-target-min: var(--smrt-touch-target-min);
  }
  .smrt-input__root[data-density='comfortable'] {
    --smrt-input-target-min: 0px;
  }
  .smrt-input__root {
    min-height: max(var(--smrt-control-height), var(--smrt-input-target-min, var(--smrt-control-target-min)));
  }
}
@layer smrt.theme {
  .smrt-input__root {
    font-size: var(--smrt-typography-body-medium-size);
    font-weight: var(--smrt-control-weight);
    line-height: var(--smrt-typography-body-medium-line-height);
    color: var(--smrt-color-on-surface);
    background-color: var(--smrt-surface-control);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-control-radius);
    transition: border-color var(--smrt-duration-short2) var(--smrt-easing-standard),
			box-shadow var(--smrt-duration-short2) var(--smrt-easing-standard);
  }
  .smrt-input__root:focus {
    border-color: var(--smrt-color-primary);
  }
  .smrt-input__root:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-input__root[data-smrt-highlighted='true'] {
    outline: 3px solid var(--smrt-color-tertiary);
    outline-offset: 3px;
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--smrt-color-tertiary) 20%, transparent);
  }
  .smrt-input__root:disabled {
    background-color: var(--smrt-color-surface-container-high);
    opacity: var(--smrt-state-disabled);
  }
  .smrt-input__root::placeholder {
    color: var(--smrt-color-on-surface-variant);
  }
  @media (max-width: 48rem) {
    .smrt-input__root {
      font-size: max(var(--smrt-typography-body-medium-size), 16px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-input__root {
      transition: none;
    }
  }
}
</style>
