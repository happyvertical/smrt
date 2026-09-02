<script lang="ts">
import type { Snippet } from 'svelte';
import type { ControlInteractionOptions } from './control-interaction.js';
import {
  type FormGroupContextValue,
  nextFieldId,
  setFormGroupContext,
} from './form-group-context.js';

export interface Props {
  /** Text label displayed for the form field. */
  label: string;
  /** Optional ID for the input inside the group. */
  id?: string;
  /** Optional error message shown in alert color. */
  error?: string;
  /** Optional help text displayed below the control. */
  hint?: string;
  /** Whether the form control is required. */
  required?: boolean;
  /** Agent/tutorial interaction metadata inherited by the wrapped control. */
  interaction?: ControlInteractionOptions | false;
  /** Form control (input, checkbox, etc.) inside the group. */
  children: Snippet;
}

const {
  label,
  id,
  error,
  hint,
  required = false,
  interaction,
  children,
}: Props = $props();

// Stable id so the label's `for` and the wrapped input's `id` agree even when
// the consumer doesn't pass one.
const instanceId = $props.id();
const fallbackId = `smrt-field-${instanceId}`;
const fieldId = $derived(id ?? fallbackId);
const hintId = $derived(hint && !error ? `${fieldId}-hint` : undefined);
const errorId = $derived(error ? `${fieldId}-error` : undefined);
const describedBy = $derived(
  [hintId, errorId].filter(Boolean).join(' ') || undefined,
);

// Publish the wiring a base input auto-applies (getter stays reactive as
// hint/error change).
setFormGroupContext(
  (): FormGroupContextValue => ({
    inputId: fieldId,
    describedBy,
    invalid: !!error,
    label,
    description: hint,
    required,
    error,
    interaction,
  }),
);
</script>

<div class="form-group">
	<label for={fieldId} class="form-label">
		{label}
		{#if required}
			<span class="required" aria-hidden="true">*</span>
		{/if}
	</label>
	{@render children()}
	{#if hintId}
		<p id={hintId} class="form-hint">{hint}</p>
	{/if}
	{#if errorId}
		<p id={errorId} class="form-error" role="alert">{error}</p>
	{/if}
</div>

<style>
	.form-group {
		margin-bottom: 1rem;
	}

	.form-label {
		display: block;
		font-size: var(--smrt-typography-label-large-size, 0.875rem);
		font-weight: var(--smrt-typography-weight-medium, 500);
		color: var(--smrt-color-on-surface, #374151);
		margin-bottom: 0.375rem;
	}

	.required {
		color: var(--smrt-color-error, #ba1a1a);
		margin-left: 0.125rem;
	}

	.form-hint {
		margin: 0.25rem 0 0;
		font-size: var(--smrt-typography-body-small-size, 0.75rem);
		color: var(--smrt-color-on-surface-variant, #6b7280);
	}

	.form-error {
		margin: 0.25rem 0 0;
		font-size: var(--smrt-typography-body-small-size, 0.75rem);
		color: var(--smrt-color-error, #ba1a1a);
	}
</style>
