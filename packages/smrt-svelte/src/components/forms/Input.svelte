<script lang="ts">
interface Props {
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
		color: #1f2937;
		background-color: #fff;
		border: 1px solid #d1d5db;
		border-radius: 0.375rem;
		transition:
			border-color 0.15s ease-in-out,
			box-shadow 0.15s ease-in-out;
	}

	.input:focus {
		outline: none;
		border-color: #3b82f6;
		box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
	}

	.input:disabled {
		background-color: #f3f4f6;
		cursor: not-allowed;
		opacity: 0.7;
	}

	.input::placeholder {
		color: #9ca3af;
	}
</style>
