<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface Props extends Omit<HTMLButtonAttributes, 'class'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  children?: Snippet;
}

const {
  variant = 'primary',
  size = 'md',
  href,
  disabled = false,
  type = 'button',
  onclick,
  children,
  ...rest
}: Props = $props();

const _isLink = $derived(!!href);
</script>

{#if isLink}
  <a
    {href}
    class="button {variant} {size}"
    class:disabled
    aria-disabled={disabled}
    role="button"
    tabindex={disabled ? -1 : 0}
    {...rest}
  >
    {@render children?.()}
  </a>
{:else}
  <button
    {type}
    {disabled}
    {onclick}
    class="button {variant} {size}"
    {...rest}
  >
    {@render children?.()}
  </button>
{/if}

<style>
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm);
    font-weight: var(--font-weight-medium);
    border-radius: var(--radius-md);
    transition: all var(--transition-base);
    cursor: pointer;
    text-decoration: none;
    border: 1px solid transparent;
  }

  /* Sizes */
  .sm {
    padding: var(--spacing-sm) var(--spacing-md);
    font-size: var(--font-size-sm);
  }

  .md {
    padding: var(--spacing-md) var(--spacing-lg);
    font-size: var(--font-size-base);
  }

  .lg {
    padding: var(--spacing-lg) var(--spacing-xl);
    font-size: var(--font-size-lg);
  }

  /* Variants */
  .primary {
    background: var(--color-primary-main);
    color: var(--color-text-inverse);
  }

  .primary:hover:not(:disabled) {
    background: var(--color-primary-dark);
  }

  .secondary {
    background: var(--color-neutral-white);
    color: var(--color-primary-main);
    border-color: var(--color-primary-main);
  }

  .secondary:hover:not(:disabled) {
    background: var(--color-primary-light);
  }

  .ghost {
    background: transparent;
    color: var(--color-primary-main);
  }

  .ghost:hover:not(:disabled) {
    background: var(--color-primary-light);
  }

  .danger {
    background: var(--color-semantic-error);
    color: var(--color-text-inverse);
  }

  .danger:hover:not(:disabled) {
    background: #d32f2f;
  }

  /* Disabled state */
  .button:disabled,
  .button.disabled {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }

  /* Focus state */
  .button:focus-visible {
    outline: 2px solid var(--color-primary-main);
    outline-offset: 2px;
  }
</style>
