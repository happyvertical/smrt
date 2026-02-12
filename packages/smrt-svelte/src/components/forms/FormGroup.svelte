<script lang="ts">
import type { Snippet } from 'svelte';

export interface Props {
  label: string;
  id?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: Snippet;
}

const { label, id, error, hint, required = false, children }: Props = $props();
</script>

<div class="form-group">
	<label for={id} class="form-label">
		{label}
		{#if required}
			<span class="required">*</span>
		{/if}
	</label>
	{@render children()}
	{#if hint && !error}
		<p class="form-hint">{hint}</p>
	{/if}
	{#if error}
		<p class="form-error">{error}</p>
	{/if}
</div>

<style>
	.form-group {
		margin-bottom: 1rem;
	}

	.form-label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--smrt-color-on-surface, #374151);
		margin-bottom: 0.375rem;
	}

	.required {
		color: var(--smrt-color-error, #ba1a1a);
		margin-left: 0.125rem;
	}

	.form-hint {
		margin: 0.25rem 0 0;
		font-size: 0.75rem;
		color: var(--smrt-color-on-surface-variant, #6b7280);
	}

	.form-error {
		margin: 0.25rem 0 0;
		font-size: 0.75rem;
		color: var(--smrt-color-error, #ba1a1a);
	}
</style>
