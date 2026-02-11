<script lang="ts">
/**
 * Button - Versatile button component
 *
 * Supports both button and link rendering. When href is provided,
 * renders as an anchor tag. Otherwise renders as a button.
 */
import type { Snippet } from 'svelte';
import type {
  HTMLAnchorAttributes,
  HTMLButtonAttributes,
} from 'svelte/elements';
import type { ButtonSize, ButtonVariant } from '../../types-generic';

/** Props for Button component */
export interface Props extends Omit<HTMLButtonAttributes, 'class' | 'href'> {
  /** Visual variant */
  variant?: ButtonVariant;
  /** Size variant */
  size?: ButtonSize;
  /** URL for link mode (renders as <a> tag) */
  href?: string;
  /** Snippet for button content */
  children?: Snippet;
  /** Full width button */
  fullWidth?: boolean;
  /** Loading state */
  loading?: boolean;
}

const {
  variant = 'primary',
  size = 'md',
  href,
  disabled = false,
  loading = false,
  type = 'button',
  fullWidth = false,
  onclick,
  children,
  ...rest
}: Props = $props();

const isLink = $derived(!!href);
const isDisabled = $derived(disabled || loading);

// Button-specific props to exclude in link mode
const buttonOnlyProps = new Set([
  'type',
  'disabled',
  'form',
  'formAction',
  'formEnctype',
  'formMethod',
  'formNoValidate',
  'formTarget',
]);

// Filter out button-specific props for link mode
const linkProps = $derived(() => {
  return Object.fromEntries(
    Object.entries(rest).filter(([key]) => !buttonOnlyProps.has(key)),
  ) as HTMLAnchorAttributes;
});
</script>

{#if isLink}
  <a
    {href}
    class="button {variant} {size}"
    class:disabled={isDisabled}
    class:full-width={fullWidth}
    class:loading
    aria-disabled={isDisabled}
    aria-busy={loading}
    onclick={onclick as HTMLAnchorAttributes['onclick']}
    {...linkProps()}
  >
    {#if loading}
      <span class="spinner" aria-hidden="true"></span>
    {/if}
    <span class="content" class:loading>
      {@render children?.()}
    </span>
  </a>
{:else}
  <button
    {type}
    disabled={isDisabled}
    aria-busy={loading}
    class="button {variant} {size}"
    class:full-width={fullWidth}
    class:loading
    {onclick}
    {...rest}
  >
    {#if loading}
      <span class="spinner" aria-hidden="true"></span>
    {/if}
    <span class="content" class:loading>
      {@render children?.()}
    </span>
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

  .primary:hover:not(:disabled):not(.disabled) {
    background: var(--color-primary-dark);
  }

  .secondary {
    background: var(--color-neutral-white);
    color: var(--color-primary-main);
    border-color: var(--color-primary-main);
  }

  .secondary:hover:not(:disabled):not(.disabled) {
    background: var(--color-primary-light);
  }

  .ghost {
    background: transparent;
    color: var(--color-primary-main);
  }

  .ghost:hover:not(:disabled):not(.disabled) {
    background: var(--color-primary-light);
  }

  .danger {
    background: var(--color-semantic-error);
    color: var(--color-text-inverse);
  }

  .danger:hover:not(:disabled):not(.disabled) {
    background: var(--color-semantic-error-dark, #d32f2f);
  }

  /* Full width */
  .full-width {
    width: 100%;
  }

  /* Loading state */
  .loading {
    position: relative;
  }

  .spinner {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 1em;
    height: 1em;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }

  @keyframes spin {
    from { transform: translate(-50%, -50%) rotate(0deg); }
    to { transform: translate(-50%, -50%) rotate(360deg); }
  }

  .content.loading {
    opacity: 0;
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

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
