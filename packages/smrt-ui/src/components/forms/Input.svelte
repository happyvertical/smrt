<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import { tryGetFormGroupContext } from './form-group-context.js';

export interface Props extends Omit<HTMLInputAttributes, 'class' | 'value'> {
  value?: string | number;
  class?: string;
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
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
  ...rest
}: Props = $props();

// When wrapped in a <FormGroup>, inherit the id (so its <label for> resolves),
// the hint/error association, and the error state — unless set explicitly.
const formGroup = tryGetFormGroupContext();
const resolvedId = $derived(id ?? formGroup?.().inputId);
const resolvedDescribedBy = $derived(
  ariaDescribedby ?? formGroup?.().describedBy,
);
const resolvedInvalid = $derived(
  ariaInvalid ?? (formGroup?.().invalid ? 'true' : undefined),
);
</script>

<input
	id={resolvedId}
	{type}
	bind:value
	{placeholder}
	{disabled}
	{readonly}
	{required}
	{name}
	aria-describedby={resolvedDescribedBy}
	aria-invalid={resolvedInvalid}
	class="input {className}"
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
		border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
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

	.input:disabled {
		background-color: var(--smrt-color-surface-container-high, #f3f4f6);
		cursor: not-allowed;
		opacity: 0.7;
	}

	.input::placeholder {
		color: var(--smrt-color-on-surface-variant, #9ca3af);
	}
</style>
