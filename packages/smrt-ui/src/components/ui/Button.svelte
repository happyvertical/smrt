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
  /** Target density; omit to inherit the ThemeProvider setting. */
  density?: 'comfortable' | 'touch';
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
  /**
   * Anchor-mode attributes (link mode only, i.e. when `href` is set). The
   * component already spreads these onto the rendered `<a>`; they are declared
   * here so callers migrating an external `<a target="_blank" rel="...">` to
   * Button (issue #1589) keep them type-checked. Ignored in button mode.
   */
  target?: HTMLAnchorAttributes['target'];
  /** Specifies the relationship between the button link and the target URL. */
  rel?: HTMLAnchorAttributes['rel'];
  /** Prompts download of the linked resource instead of navigating to it. */
  download?: HTMLAnchorAttributes['download'];
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
  // Anchor-mode attributes pulled out of `rest` so they are only ever applied
  // in link mode below — in button mode they are dropped, matching the doc and
  // avoiding invalid `<button target=...>` HTML (PR #1608 review).
  target,
  rel,
  download,
  density,
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

// Attributes the disabled link sets itself. `rest` is spread *after* the
// explicit attributes on the <a>, so without excluding these a caller-supplied
// `tabindex` / `aria-disabled` in `rest` would win and make a "disabled" link
// focusable or announced as enabled again (PR #1602 review). Only stripped
// while disabled, so an enabled link still honors a caller's tabindex.
const disabledControlledProps = new Set(['tabindex', 'aria-disabled']);

// Filter out button-specific props (always) and the self-controlled disabled
// attributes (while disabled) for link mode.
const linkProps = $derived(() => {
  return Object.fromEntries(
    Object.entries(rest).filter(
      ([key]) =>
        !buttonOnlyProps.has(key) &&
        !(isDisabled && disabledControlledProps.has(key)),
    ),
  ) as HTMLAnchorAttributes;
});

function handleClick(event: MouseEvent) {
  if (isDisabled) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  onclick?.(
    event as Parameters<NonNullable<HTMLButtonAttributes['onclick']>>[0],
  );
}
</script>

{#if isLink}
  <a
    href={isDisabled ? undefined : href}
    {target}
    {rel}
    {download}
    data-density={density} class="button {variant} {size} {className}"
    class:disabled={isDisabled}
    class:full-width={fullWidth}
    class:loading
    tabindex={isDisabled ? -1 : undefined}
    aria-disabled={isDisabled}
    aria-busy={loading}
    onclick={handleClick as HTMLAnchorAttributes['onclick']}
    {...linkProps()} data-smrt-component="Button"
  >
    {#if loading}
      <span class="spinner" aria-hidden="true" data-smrt-part="spinner"></span>
    {/if}
    <span class="content" class:loading data-smrt-part="label">
      {@render children?.()}
    </span>
  </a>
{:else}
  <button
    {type}
    disabled={isDisabled}
    aria-busy={loading}
    data-density={density} class="button {variant} {size} {className}"
    class:full-width={fullWidth}
    class:loading
    onclick={handleClick}
    {...rest} data-smrt-component="Button"
  >
    {#if loading}
      <span class="spinner" aria-hidden="true" data-smrt-part="spinner"></span>
    {/if}
    <span class="content" class:loading data-smrt-part="label">
      {@render children?.()}
    </span>
  </button>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2);
    position: relative;
    font-weight: var(--smrt-control-weight);
    border-radius: var(--smrt-control-radius);
    transition: all var(--smrt-duration-short2) var(--smrt-easing-standard);
    cursor: pointer;
    text-decoration: none;
    border: 1px solid transparent;
  }

  /* One state layer for every variant: currentColor mixed at the theme's
     state opacity. Per-variant tweaks use --smrt-button-state-* names. */
  .button::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: transparent;
    pointer-events: none;
    transition: background-color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }

  .button:hover:not(:disabled):not(.disabled)::after {
    background: color-mix(
      in srgb,
      currentColor calc(var(--smrt-state-hover) * 100%),
      transparent
    );
  }

  .button:active:not(:disabled):not(.disabled)::after {
    background: color-mix(
      in srgb,
      currentColor calc(var(--smrt-state-pressed) * 100%),
      transparent
    );
  }

  /* Sizes */
  .sm {
    border-radius: var(--smrt-control-radius-small);
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


  .secondary {
    background: var(--smrt-surface-control);
    color: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }


  .ghost {
    background: transparent;
    color: var(--smrt-color-primary);
  }


  .danger {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
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
    border-radius: var(--smrt-radius-full);
    animation: spin 0.75s linear infinite;
  }

  @keyframes spin {
    from { transform: translate(-50%, -50%) rotate(0deg); }
    to { transform: translate(-50%, -50%) rotate(360deg); }
  }

  /* Lay out the button's own children. The children render inside this wrapper
     span, so the button-level `gap` never reaches them — without making the
     wrapper itself a flex row, an icon + label (`<Button><svg/>Save</Button>`)
     would render with no gap. Making `.content` a centered flex row lays out
     multi-child buttons (icon+text, label+count) correctly after the #1589
     migration, instead of needing per-button CSS to reach into `.content`. The
     wrapper is shrink-to-fit, so a caller wanting a spread layout must also give
     it width — e.g. a full-width button with
     `.x :global(.content) { width: 100%; justify-content: space-between }`. */
  .content {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2);
  }

  .content.loading {
    opacity: 0;
  }

  /* Disabled state */
  .button:disabled,
  .button.disabled {
    opacity: var(--smrt-state-disabled);
    cursor: not-allowed;
    pointer-events: none;
  }

  /* Focus state */
  .button:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }

  /* Phones: every size is at least a 44px touch target. */
  @media (max-width: 48rem) {
    .button {
      min-block-size: 2.75rem;
    }
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }

  .button[data-density='touch'] { --smrt-control-target-min: var(--smrt-touch-target-min); }
  .button[data-density='comfortable'] { --smrt-control-target-min: 0px; }
  .button { min-height: max(var(--smrt-control-height), var(--smrt-control-target-min, 0px)); min-width: var(--smrt-control-target-min, 0px); }
  .button.sm { min-height: max(var(--smrt-control-height-small), var(--smrt-control-target-min, 0px)); }
}
</style>
