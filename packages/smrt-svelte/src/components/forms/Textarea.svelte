<script lang="ts">
interface Props {
  id?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  name?: string;
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
}: Props = $props();
</script>

<textarea
	{id}
	bind:value
	{placeholder}
	{disabled}
	readonly={readonly}
	{required}
	{name}
	{rows}
	class="textarea {className}"
></textarea>

<style>
	.textarea {
		display: block;
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		line-height: 1.5;
		color: #1f2937;
		background-color: #fff;
		border: 1px solid #d1d5db;
		border-radius: 0.375rem;
		resize: vertical;
		min-height: 80px;
		transition:
			border-color 0.15s ease-in-out,
			box-shadow 0.15s ease-in-out;
	}

	.textarea:focus {
		outline: none;
		border-color: #3b82f6;
		box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
	}

	.textarea:disabled {
		background-color: #f3f4f6;
		cursor: not-allowed;
		opacity: 0.7;
	}

	.textarea::placeholder {
		color: #9ca3af;
	}
</style>
