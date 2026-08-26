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
import { tryGetFormGroupContext } from './form-group-context.js';

export interface Props extends Omit<HTMLInputAttributes, 'class' | 'value'> {
  value?: string | number;
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
  candidate.value = String(next ?? '');
  return {
    valid: candidate.checkValidity(),
    message: candidate.validationMessage || undefined,
  };
}

$effect(() => {
  const context = controlInteraction;
  const element = inputEl;
  const controlId = resolvedControlId;
  const options = resolvedInteraction;
  if (!context || !element || !controlId || options === false) return;

  return context.registry.register({
    identity: {
      formId: context.formId,
      controlId,
      subject: options.subject,
    },
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
  });
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
	class="input {className}"
	data-smrt-control={resolvedControlId}
	data-smrt-form={controlInteraction?.formId}
	data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
	data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}
	{...rest}
/>

<style>
	.input {
		display: block;
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: var(--smrt-typography-body-medium-size, 0.875rem);
		line-height: var(--smrt-typography-body-medium-line-height, 1.5);
		color: var(--smrt-color-on-surface, #1f2937);
		background-color: var(--smrt-color-surface, #fff);
		border: 1px solid var(--smrt-color-outline, #6b7280);
		border-radius: var(--smrt-radius-small, 0.375rem);
		transition:
			border-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease-in-out),
			box-shadow var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease-in-out);
	}

	.input:focus {
		outline: none;
		border-color: var(--smrt-color-primary, #005ac1);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
	}

	.input[data-smrt-highlighted='true'] {
		outline: 3px solid var(--smrt-color-tertiary, #7d5260);
		outline-offset: 3px;
		box-shadow: 0 0 0 6px color-mix(in srgb, var(--smrt-color-tertiary, #7d5260) 20%, transparent);
	}

	.input:disabled {
		background-color: var(--smrt-color-surface-container-high, #f3f4f6);
		cursor: not-allowed;
		opacity: 0.7;
	}

	.input::placeholder {
		color: var(--smrt-color-on-surface-variant, #9ca3af);
	}

	@media (prefers-reduced-motion: reduce) {
		.input {
			transition: none;
		}
	}
</style>
