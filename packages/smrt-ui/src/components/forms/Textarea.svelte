<script lang="ts">
import type { HTMLTextareaAttributes } from 'svelte/elements';
import {
  emitControlChange,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import { tryGetFormGroupContext } from './form-group-context.js';

export interface Props extends Omit<HTMLTextareaAttributes, 'class' | 'value'> {
  value?: string;
  rows?: number;
  class?: string;
  interaction?: ControlInteractionOptions | false;
}

let {
  id,
  value = $bindable(''),
  placeholder,
  disabled = false,
  readonly = false,
  required = false,
  name,
  rows = 4,
  class: className = '',
  interaction,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
  ...rest
}: Props = $props();

// Inherit id / hint+error association / error state from a wrapping FormGroup.
const formGroup = tryGetFormGroupContext();
const controlInteraction = tryGetControlInteractionContext();
let textareaEl = $state<HTMLTextAreaElement | null>(null);
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
  if (textareaEl) emitControlChange(textareaEl);
}

$effect(() => {
  const context = controlInteraction;
  const element = textareaEl;
  const controlId = resolvedControlId;
  const options = resolvedInteraction;
  if (!context || !element || !controlId || options === false) return;
  return context.registry.register({
    identity: { formId: context.formId, controlId, subject: options.subject },
    metadata: {
      kind: 'textarea',
      label: formGroup?.().label ?? ariaLabel ?? undefined,
      description: options.description ?? formGroup?.().description,
      sensitivity: options.sensitivity ?? 'public',
      readable: options.readable,
      writable: options.writable,
      constraints: {
        required: required === true,
        minLength: element.minLength >= 0 ? element.minLength : undefined,
        maxLength: element.maxLength >= 0 ? element.maxLength : undefined,
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
    getState: () => ({
      disabled: element.disabled,
      readonly: element.readOnly,
      valid: element.validity.valid,
      validationMessage: element.validationMessage || undefined,
    }),
  });
});

export function focus(): void {
  textareaEl?.focus();
}

export function getElement(): HTMLTextAreaElement | null {
  return textareaEl;
}
</script>

	<textarea
		bind:this={textareaEl}
	id={resolvedId}
	bind:value
	{placeholder}
	{disabled}
	{readonly}
	{required}
		{name}
		aria-label={ariaLabel}
	{rows}
	aria-describedby={resolvedDescribedBy}
	aria-invalid={resolvedInvalid}
		class="textarea {className}"
		data-smrt-control={resolvedControlId}
		data-smrt-form={controlInteraction?.formId}
		data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
		data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}
	{...rest}
></textarea>

<style>
	.textarea {
		display: block;
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: var(--smrt-typography-body-medium-size, 0.875rem);
		line-height: var(--smrt-typography-body-medium-line-height, 1.5);
		color: var(--smrt-color-on-surface, #1f2937);
		background-color: var(--smrt-color-surface, #fff);
		border: 1px solid var(--smrt-color-outline, #6b7280);
		border-radius: 0.375rem;
		resize: vertical;
		min-height: 80px;
		transition:
			border-color 0.15s ease-in-out,
			box-shadow 0.15s ease-in-out;
	}

	.textarea:focus {
		outline: none;
		border-color: var(--smrt-color-primary, #005ac1);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
	}

	.textarea[data-smrt-highlighted='true'] {
		outline: 3px solid var(--smrt-color-tertiary, #7d5260);
		outline-offset: 3px;
	}

	.textarea:disabled {
		background-color: var(--smrt-color-surface-container-high, #f3f4f6);
		cursor: not-allowed;
		opacity: 0.7;
	}

	.textarea::placeholder {
		color: var(--smrt-color-on-surface-variant, #9ca3af);
	}

	@media (prefers-reduced-motion: reduce) {
		.textarea {
			transition: none;
		}
	}
</style>
