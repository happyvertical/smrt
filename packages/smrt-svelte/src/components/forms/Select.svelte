<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
  id?: string;
  value?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  class?: string;
  children: Snippet;
}

let {
  id,
  value = $bindable(''),
  disabled = false,
  required = false,
  name,
  class: className = '',
  children,
}: Props = $props();
</script>

<select
	{id}
	bind:value
	{disabled}
	{required}
	{name}
	class="select {className}"
>
	{@render children()}
</select>

<style>
	.select {
		display: block;
		width: 100%;
		padding: 0.5rem 2rem 0.5rem 0.75rem;
		font-size: 0.875rem;
		line-height: 1.5;
		color: #1f2937;
		background-color: #fff;
		background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
		background-position: right 0.5rem center;
		background-repeat: no-repeat;
		background-size: 1.5em 1.5em;
		border: 1px solid #d1d5db;
		border-radius: 0.375rem;
		appearance: none;
		cursor: pointer;
		transition:
			border-color 0.15s ease-in-out,
			box-shadow 0.15s ease-in-out;
	}

	.select:focus {
		outline: none;
		border-color: #3b82f6;
		box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
	}

	.select:disabled {
		background-color: #f3f4f6;
		cursor: not-allowed;
		opacity: 0.7;
	}
</style>
