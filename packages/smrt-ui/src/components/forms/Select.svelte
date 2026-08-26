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
import { tryGetFormGroupContext } from './form-group-context.js';

export interface Props extends Omit<HTMLSelectAttributes, 'class' | 'value'> {
  value?: string;
  class?: string;
  interaction?: ControlInteractionOptions | false;
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

$effect(() => {
  const context = controlInteraction;
  const element = selectEl;
  const controlId = resolvedControlId;
  const options = resolvedInteraction;
  if (!context || !element || !controlId || options === false) return;
  return context.registry.register({
    identity: { formId: context.formId, controlId, subject: options.subject },
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
        disabled: option.disabled,
      })),
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
      valid: element.validity.valid,
      validationMessage: element.validationMessage || undefined,
    }),
  });
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
		class="select {className}"
		data-smrt-control={resolvedControlId}
		data-smrt-form={controlInteraction?.formId}
		data-smrt-subject-type={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.type}
		data-smrt-subject-id={resolvedInteraction === false ? undefined : resolvedInteraction.subject?.id}
	{...rest}
>
	{@render children()}
</select>

<style>
	.select {
		display: block;
		width: 100%;
		padding: 0.5rem 2rem 0.5rem 0.75rem;
		font-size: var(--smrt-typography-body-medium-size, 0.875rem);
		line-height: var(--smrt-typography-body-medium-line-height, 1.5);
		color: var(--smrt-color-on-surface, #1f2937);
		background-color: var(--smrt-color-surface, #fff);
		background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%2379747e' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
		background-position: right 0.5rem center;
		background-repeat: no-repeat;
		background-size: 1.5em 1.5em;
		border: 1px solid var(--smrt-color-outline, #6b7280);
		border-radius: 0.375rem;
		appearance: none;
		cursor: pointer;
		transition:
			border-color 0.15s ease-in-out,
			box-shadow 0.15s ease-in-out;
	}

	.select:focus {
		outline: none;
		border-color: var(--smrt-color-primary, #005ac1);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
	}

	.select[data-smrt-highlighted='true'] {
		outline: 3px solid var(--smrt-color-tertiary, #7d5260);
		outline-offset: 3px;
	}

	.select:disabled {
		background-color: var(--smrt-color-surface-container-high, #f3f4f6);
		cursor: not-allowed;
		opacity: 0.7;
	}

	@media (prefers-reduced-motion: reduce) {
		.select {
			transition: none;
		}
	}
</style>
