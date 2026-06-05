<script lang="ts">
export interface Props {
  id?: string;
  type?: 'text' | 'email' | 'password' | 'number' | 'url' | 'tel' | 'search';
  value?: string | number;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  name?: string;
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
}: Props = $props();
</script>

<input
	{id}
	{type}
	bind:value
	{placeholder}
	{disabled}
	readonly={readonly}
	{required}
	{name}
	class="input {className}"
/>

<style>
	.input {
		display: block;
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		line-height: 1.5;
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
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #0b57d0) 10%, transparent);
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
