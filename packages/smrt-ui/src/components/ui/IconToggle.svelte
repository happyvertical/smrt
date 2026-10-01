<script lang="ts">
/**
 * IconToggle — an icon-only toggle button for dense filter and view-switcher
 * rows. The icon is the `children` snippet (any icon set); `label` is both the
 * accessible name and the tooltip text. `pressed` is reflected with
 * `aria-pressed`, so a row of them is a one-of-many (or a many) toggle group;
 * the owner decides what pressing means (this component keeps no state). An
 * optional `count` shows as a small badge and is part of the accessible name
 * and tooltip. The hit area is at least 44px square.
 */
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
import type { TooltipPlacement } from '../../types-generic';
import Tooltip from './Tooltip.svelte';

export interface Props
  extends Omit<
    HTMLButtonAttributes,
    'class' | 'children' | 'aria-label' | 'aria-pressed' | 'title'
  > {
  /** Accessible name and tooltip text (what the button does or filters). */
  label: string;
  /** Whether the toggle is on (`aria-pressed`). */
  pressed?: boolean;
  /** Optional count badge; included in the accessible name and tooltip. */
  count?: number;
  /** The icon. Decorative: it is hidden from assistive technology. */
  children: Snippet;
  /** Where the tooltip opens. */
  tooltipPlacement?: TooltipPlacement;
  /** Additional CSS class names. */
  class?: string;
}

const {
  label,
  pressed = false,
  count,
  children,
  tooltipPlacement = 'top',
  disabled = false,
  type = 'button',
  class: className = '',
  ...rest
}: Props = $props();

const name = $derived(count === undefined ? label : `${label} (${count})`);
</script>

<Tooltip text={name} placement={tooltipPlacement}>
  <button
    {...rest}
    {type}
    {disabled}
    class="icon-toggle {className}"
    class:pressed
    aria-pressed={pressed}
    aria-label={name}
  >
    <span class="icon" aria-hidden="true">{@render children()}</span>
    {#if count !== undefined}<span class="count" aria-hidden="true">{count}</span>{/if}
  </button>
</Tooltip>

<style>
  .icon-toggle {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 2.75rem;
    min-height: 2.75rem;
    padding: 0;
    border: 1px solid var(--smrt-color-outline-variant, var(--smrt-color-outline));
    border-radius: var(--smrt-radius-full, 999px);
    background: var(--smrt-color-surface-container, var(--smrt-color-surface));
    color: var(--smrt-color-on-surface);
    font: inherit;
    cursor: pointer;
  }
  .icon-toggle:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-high, var(--smrt-color-surface-container));
  }
  .icon-toggle.pressed {
    border-color: transparent;
    background: var(--smrt-color-primary-container, var(--smrt-color-secondary-container));
    color: var(--smrt-color-on-primary-container, var(--smrt-color-on-secondary-container));
  }
  .icon-toggle:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  .icon-toggle:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .icon {
    display: inline-flex;
  }
  .count {
    position: absolute;
    z-index: 2;
    top: -0.3rem;
    right: -0.3rem;
    box-sizing: border-box;
    min-width: 1.15rem;
    padding: 0 0.3rem;
    border-radius: var(--smrt-radius-full, 999px);
    /* Outlined, not filled: a surface-coloured face (so the button's edge does
       not show through where the badge overlaps it), a 1px theme outline and
       neutral text, readable on light and dark themes alike. */
    border: 1px solid var(--smrt-color-outline);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1.15rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>
