<script lang="ts">
import type { Snippet } from 'svelte';

export interface Props {
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
		color: var(--smrt-color-on-surface, #1f2937);
		background-color: var(--smrt-color-surface, #fff);
		background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%2379747e' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
		background-position: right 0.5rem center;
		background-repeat: no-repeat;
		background-size: 1.5em 1.5em;
		border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
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

	.select:disabled {
		background-color: var(--smrt-color-surface-container-high, #f3f4f6);
		cursor: not-allowed;
		opacity: 0.7;
	}
</style>
