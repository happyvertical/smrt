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
  /**
   * Extra class(es) appended after the base `button {variant} {size}` styling.
   * Lets callers adopt Button for custom-styled buttons without losing their
   * own CSS (issue #1589) — the base button styling still applies.
   */
  class?: string;
}

const {
  variant = 'primary',
  size = 'md',
  href,
  disabled = false,
  loading = false,
  type = 'button',
  fullWidth = false,
  class: className = '',
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
    href={isDisabled ? undefined : href}
    class="button {variant} {size} {className}"
    class:disabled={isDisabled}
    class:full-width={fullWidth}
    class:loading
    tabindex={isDisabled ? -1 : undefined}
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
    class="button {variant} {size} {className}"
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
    gap: var(--smrt-spacing-2);
    font-weight: var(--smrt-typography-body-medium-weight);
    border-radius: var(--smrt-radius-medium);
    transition: all var(--smrt-duration-short2) var(--smrt-easing-standard);
    cursor: pointer;
    text-decoration: none;
    border: 1px solid transparent;
  }

  /* Sizes */
  .sm {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    font-size: var(--smrt-typography-body-medium-size);
  }

  .md {
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
    font-size: var(--smrt-typography-body-large-size);
  }

  .lg {
    padding: var(--smrt-spacing-4) var(--smrt-spacing-6);
    font-size: var(--smrt-typography-title-medium-size);
  }

  /* Variants */
  .primary {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  /* M3 hover state layer: 8% of the on-color blended over the base, so the
     button visibly darkens on hover instead of repeating its base color. */
  .primary:hover:not(:disabled):not(.disabled) {
    background: color-mix(
      in srgb,
      var(--smrt-color-on-primary) 8%,
      var(--smrt-color-primary)
    );
  }

  .secondary {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }

  .secondary:hover:not(:disabled):not(.disabled) {
    background: var(--smrt-color-primary-container);
  }

  .ghost {
    background: transparent;
    color: var(--smrt-color-primary);
  }

  .ghost:hover:not(:disabled):not(.disabled) {
    background: var(--smrt-color-primary-container);
  }

  .danger {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }

  .danger:hover:not(:disabled):not(.disabled) {
    background: color-mix(
      in srgb,
      var(--smrt-color-on-error) 8%,
      var(--smrt-color-error)
    );
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
    border-radius: var(--smrt-radius-full, 9999px);
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
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
