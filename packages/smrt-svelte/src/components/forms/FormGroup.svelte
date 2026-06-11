<script lang="ts">
import type { Snippet } from 'svelte';
import {
  type FormGroupContextValue,
  nextFieldId,
  setFormGroupContext,
} from '../../state/form-group-context.js';

export interface Props {
  label: string;
  id?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: Snippet;
}

const { label, id, error, hint, required = false, children }: Props = $props();

// Stable id so the label's `for` and the wrapped input's `id` agree even when
// the consumer doesn't pass one.
const fallbackId = nextFieldId();
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
