<script lang="ts">
import type { HTMLTextareaAttributes } from 'svelte/elements';
import { tryGetFormGroupContext } from './form-group-context.js';

export interface Props extends Omit<HTMLTextareaAttributes, 'class' | 'value'> {
  value?: string;
  rows?: number;
  class?: string;
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
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
  ...rest
}: Props = $props();

// Inherit id / hint+error association / error state from a wrapping FormGroup.
const formGroup = tryGetFormGroupContext();
const resolvedId = $derived(id ?? formGroup?.().inputId);
const resolvedDescribedBy = $derived(
  ariaDescribedby ?? formGroup?.().describedBy,
);
const resolvedInvalid = $derived(
  ariaInvalid ?? (formGroup?.().invalid ? 'true' : undefined),
);
</script>

<textarea
	id={resolvedId}
	bind:value
	{placeholder}
	{disabled}
	{readonly}
	{required}
	{name}
	{rows}
	aria-describedby={resolvedDescribedBy}
	aria-invalid={resolvedInvalid}
	class="textarea {className}"
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
		border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
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

	.textarea:disabled {
		background-color: var(--smrt-color-surface-container-high, #f3f4f6);
		cursor: not-allowed;
		opacity: 0.7;
	}

	.textarea::placeholder {
		color: var(--smrt-color-on-surface-variant, #9ca3af);
	}
</style>
