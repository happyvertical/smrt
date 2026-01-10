<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
  id?: string;
  checked?: boolean;
  disabled?: boolean;
  name?: string;
  label?: string | Snippet;
  description?: Snippet;
  class?: string;
  onchange?: (e: Event & { currentTarget: HTMLInputElement }) => void;
  children?: Snippet;
}

let {
  id,
  checked = $bindable(false),
  disabled = false,
  name,
  label,
  description,
  class: className = '',
  onchange,
  children,
}: Props = $props();

function isSnippet(value: unknown): value is Snippet {
  return typeof value === 'function';
}
</script>

<label class="toggle {className}" class:disabled>
	<input
		type="checkbox"
		{id}
		bind:checked
		{disabled}
		{name}
		class="toggle-input"
		{onchange}
	/>
	<span class="toggle-switch"></span>
	<div class="toggle-content">
		{#if label}
			<span class="toggle-label">
				{#if isSnippet(label)}
					{@render label()}
				{:else}
					{label}
				{/if}
			</span>
		{/if}
		{#if description}
			<span class="toggle-description">
				{@render description()}
			</span>
		{/if}
		{#if children}
			{@render children()}
		{/if}
	</div>
</label>

<style>
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
	}

	.toggle.disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.toggle-input {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}

	.toggle-switch {
		position: relative;
		display: inline-block;
		width: 44px;
		height: 24px;
		background-color: #d1d5db;
		border-radius: 12px;
		transition: background-color 0.2s ease;
	}

	.toggle-switch::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 20px;
		height: 20px;
		background-color: #fff;
		border-radius: 50%;
		transition: transform 0.2s ease;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
	}

	.toggle-input:checked + .toggle-switch {
		background-color: #3b82f6;
	}

	.toggle-input:checked + .toggle-switch::after {
		transform: translateX(20px);
	}

	.toggle-input:focus + .toggle-switch {
		box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
	}

	.toggle-label {
		font-size: 0.875rem;
		color: #374151;
	}
</style>
