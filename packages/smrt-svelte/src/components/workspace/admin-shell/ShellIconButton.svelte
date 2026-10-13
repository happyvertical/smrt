<script lang="ts">
/**
 * Icon-only button used by the layout-editing chrome: a labelled `<button>`
 * with the label as tooltip, `aria-pressed` for toggles, and a 2rem hit area
 * (the same visual language as a nav row's `action`).
 */
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
import { SHELL_ICON_PATHS, type ShellIconName } from './shell-icons.js';

interface Props
  extends Omit<HTMLButtonAttributes, 'aria-label' | 'title' | 'children'> {
  /** Accessible name and tooltip. */
  label: string;
  /** Which filled icon to draw (omit when passing `children`). */
  icon?: ShellIconName;
  /** Custom icon content, drawn instead of `icon` (decorative). */
  children?: Snippet;
  /** Toggle state; omit for a plain action button. */
  pressed?: boolean;
  /** Tooltip text when it should differ from the label (default: the label). */
  tooltip?: string;
  /** Icon edge length in pixels (default 18). */
  size?: number;
}

let {
  label,
  icon,
  children,
  pressed,
  tooltip,
  size = 18,
  type = 'button',
  class: className = '',
  ...rest
}: Props = $props();
</script>

<!-- raw-primitive-allow: icon-only shell chrome control (tooltip + aria-pressed) -->
<button
  {...rest}
  {type}
  class="smrt-shell-icon-button {className}"
  aria-label={label}
  title={tooltip ?? label}
  aria-pressed={pressed} data-smrt-component="ShellIconButton"
>
  {#if children}
    {@render children()}
  {:else if icon}
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d={SHELL_ICON_PATHS[icon]} />
    </svg>
  {/if}
</button>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-shell-icon-button {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    box-sizing: border-box;
    inline-size: max(var(--smrt-control-height-small), var(--smrt-control-target-min, 0px));
    block-size: max(var(--smrt-control-height-small), var(--smrt-control-target-min, 0px));
    padding: 0;
    border: 0;
    border-radius: var(--smrt-control-radius);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }
  .smrt-shell-icon-button:hover { background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent); color: var(--smrt-color-on-surface); }
  .smrt-shell-icon-button:active { background: color-mix(in srgb, currentColor calc(var(--smrt-state-pressed) * 100%), transparent); }
  .smrt-shell-icon-button[aria-pressed='true'] { color: var(--smrt-color-on-surface); }
  .smrt-shell-icon-button:focus-visible { outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color); outline-offset: var(--smrt-focus-ring-offset); }
  .smrt-shell-icon-button:disabled { opacity: var(--smrt-state-disabled); cursor: not-allowed; }
}
</style>
