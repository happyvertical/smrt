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
   * Extra class(es) appended after the base `button smrt-button__{variant} smrt-button__{size}` styling.
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
    data-density={density} class="smrt-button__root smrt-button__{variant} smrt-button__{size} {className}"
    class:smrt-button__disabled={isDisabled}
    class:smrt-button__full-width={fullWidth}
    class:smrt-button__loading={loading}
    tabindex={isDisabled ? -1 : undefined}
    aria-disabled={isDisabled}
    aria-busy={loading}
    onclick={handleClick as HTMLAnchorAttributes['onclick']}
    {...linkProps()} data-smrt-component="Button"
  >
    {#if loading}
      <span class="smrt-button__spinner" aria-hidden="true" data-smrt-part="spinner"></span>
    {/if}
    <span class="smrt-button__content" class:smrt-button__loading={loading} data-smrt-part="label">
      {@render children?.()}
    </span>
  </a>
{:else}
  <button
    {type}
    disabled={isDisabled}
    aria-busy={loading}
    data-density={density} class="smrt-button__root smrt-button__{variant} smrt-button__{size} {className}"
    class:smrt-button__full-width={fullWidth}
    class:smrt-button__loading={loading}
    onclick={handleClick}
    {...rest} data-smrt-component="Button"
  >
    {#if loading}
      <span class="smrt-button__spinner" aria-hidden="true" data-smrt-part="spinner"></span>
    {/if}
    <span class="smrt-button__content" class:smrt-button__loading={loading} data-smrt-part="label">
      {@render children?.()}
    </span>
  </button>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-button__root {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2);
    position: relative;
    cursor: pointer;
  }
  .smrt-button__root::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .smrt-button__sm {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  .smrt-button__md {
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
  }
  .smrt-button__lg {
    padding: var(--smrt-spacing-4) var(--smrt-spacing-6);
  }
  .smrt-button__full-width {
    width: 100%;
  }
  .smrt-button__loading {
    position: relative;
  }
  .smrt-button__spinner {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 1em;
    height: 1em;
  }
  .smrt-button__content {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2);
  }
  .smrt-button__content.smrt-button__loading {
    opacity: 0;
  }
  .smrt-button__root:disabled,
  .smrt-button__root.smrt-button__disabled {
    cursor: not-allowed;
    pointer-events: none;
  }
  @media (max-width: 48rem) {
    .smrt-button__root {
      min-block-size: 2.75rem;
    }
  }
  .smrt-button__root[data-density='touch'] {
    --smrt-button-target-min: var(--smrt-touch-target-min);
  }
  .smrt-button__root[data-density='comfortable'] {
    --smrt-button-target-min: 0px;
  }
  .smrt-button__root {
    min-height: max(var(--smrt-control-height), var(--smrt-button-target-min, var(--smrt-control-target-min)));
    min-width: var(--smrt-button-target-min, var(--smrt-control-target-min));
  }
  .smrt-button__root.smrt-button__sm {
    min-height: max(var(--smrt-control-height-small), var(--smrt-button-target-min, var(--smrt-control-target-min)));
  }
}
@layer smrt.theme {
  .smrt-button__root {
    font-weight: var(--smrt-control-weight);
    border-radius: var(--smrt-control-radius);
    transition: all var(--smrt-duration-short2) var(--smrt-easing-standard);
    text-decoration: none;
    border: 1px solid transparent;
  }
  .smrt-button__root::after {
    border-radius: inherit;
    background: transparent;
    transition: background-color var(--smrt-duration-short2) var(--smrt-easing-standard);
  }
  .smrt-button__root:hover:not(:disabled):not(.smrt-button__disabled)::after {
    background: color-mix(
      in srgb,
      currentColor calc(var(--smrt-state-hover) * 100%),
      transparent
    );
  }
  .smrt-button__root:active:not(:disabled):not(.smrt-button__disabled)::after {
    background: color-mix(
      in srgb,
      currentColor calc(var(--smrt-state-pressed) * 100%),
      transparent
    );
  }
  .smrt-button__sm {
    border-radius: var(--smrt-control-radius-small);
    font-size: var(--smrt-typography-body-medium-size);
  }
  .smrt-button__md {
    font-size: var(--smrt-typography-body-large-size);
  }
  .smrt-button__lg {
    font-size: var(--smrt-typography-title-medium-size);
  }
  .smrt-button__primary {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }
  .smrt-button__secondary {
    background: var(--smrt-surface-control);
    color: var(--smrt-color-primary);
    border-color: var(--smrt-color-primary);
  }
  .smrt-button__ghost {
    background: transparent;
    color: var(--smrt-color-primary);
  }
  .smrt-button__danger {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
  }
  .smrt-button__spinner {
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: var(--smrt-radius-full);
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin {
    from {
      transform: translate(-50%, -50%) rotate(0deg);
    }
    to {
      transform: translate(-50%, -50%) rotate(360deg);
    }
  }
  .smrt-button__root:disabled,
  .smrt-button__root.smrt-button__disabled {
    opacity: var(--smrt-state-disabled);
  }
  .smrt-button__root:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-button__spinner {
      animation: none;
    }
  }
}
</style>
