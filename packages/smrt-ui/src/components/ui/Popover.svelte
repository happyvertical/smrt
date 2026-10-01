<script lang="ts">
import { type Snippet, tick } from 'svelte';

export interface Props {
  /** Accessibility label and default trigger text for the popover. */
  label: string;
  /** Content rendered inside the trigger button in place of the label text. */
  trigger?: Snippet;
  /** Accessible name of the trigger button when it shows only an icon (`aria-label`); omit to use its visible content (an icon trigger then falls back to `label`). */
  triggerLabel?: string;
  /**
   * Trigger look: `button` (bordered, the default) or `icon`, a borderless
   * 44px round icon button that takes the surrounding text colour (set the
   * colour on the popover's `class`).
   */
  variant?: 'button' | 'icon';
  /** The popover content. */
  children?: Snippet;
  /** Whether the popover is visible. */
  open?: boolean;
  /** Blocks opening the popover. */
  disabled?: boolean;
  /** Position of the popover relative to the trigger. */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  /** Closes the popover when clicking outside of it. */
  closeOnOutsideClick?: boolean;
  /** Fired when the open state changes. */
  onopenchange?: (open: boolean) => void;
  /** Additional CSS class names. */
  class?: string;
}

let {
  label,
  trigger,
  triggerLabel,
  variant = 'button',
  children,
  open = $bindable(false),
  disabled = false,
  placement = 'bottom-start',
  closeOnOutsideClick = true,
  onopenchange,
  class: className = '',
}: Props = $props();

const instanceId = $props.id();
const panelId = `popover-${instanceId}`;
let rootEl = $state<HTMLSpanElement | null>(null);
let triggerEl = $state<HTMLButtonElement | null>(null);
let panelEl = $state<HTMLDivElement | null>(null);

async function setOpen(next: boolean, focusPanel = false) {
  if (disabled) return;
  open = next;
  onopenchange?.(next);
  if (next && focusPanel) {
    await tick();
    panelEl?.focus();
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open) {
    event.preventDefault();
    setOpen(false);
    triggerEl?.focus();
  }
}

$effect(() => {
  if (!open || !closeOnOutsideClick) return;
  const handlePointerDown = (event: PointerEvent) => {
    if (rootEl && !rootEl.contains(event.target as Node)) setOpen(false);
  };
  document.addEventListener('pointerdown', handlePointerDown, true);
  return () =>
    document.removeEventListener('pointerdown', handlePointerDown, true);
});
</script>

<span bind:this={rootEl} class="popover {className}">
  <button
    bind:this={triggerEl}
    type="button"
    class="popover__trigger"
    class:popover__trigger--icon={variant === 'icon'}
    aria-haspopup="dialog"
    aria-label={triggerLabel ?? (variant === 'icon' ? label : undefined)}
    aria-expanded={open}
    aria-controls={open ? panelId : undefined}
    {disabled}
    onclick={() => setOpen(!open, !open)}
    onkeydown={handleKeydown}
  >
    {#if trigger}{@render trigger()}{:else}{label}{/if}
  </button>
  {#if open}
    <div
      bind:this={panelEl}
      id={panelId}
      class="popover__panel popover__panel--{placement}"
      role="dialog"
      aria-label={label}
      tabindex="-1"
      onkeydown={handleKeydown}
    >
      {#if children}{@render children()}{/if}
    </div>
  {/if}
</span>

<style>
  .popover { position: relative; display: inline-flex; }
  .popover__trigger { appearance: none; padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); font: inherit; cursor: pointer; }
  .popover__trigger:focus-visible, .popover__panel:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .popover__trigger:disabled { opacity: .5; cursor: not-allowed; }
  /* Icon trigger: a 44px round glyph in the surrounding colour. Hover and open nudge the glyph; focus keeps the standard primary ring (a soft ring in the glyph's colour fell under 3:1 on ordinary surfaces). */
  .popover__trigger--icon { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; inline-size: 2.75rem; block-size: 2.75rem; padding: 0; border: none; border-radius: var(--smrt-radius-full, 999px); background: transparent; color: inherit; }
  .popover__trigger--icon:hover:not(:disabled), .popover__trigger--icon[aria-expanded='true'] { background: transparent; color: color-mix(in srgb, currentColor 80%, var(--smrt-color-on-surface)); }
  .popover__trigger--icon:focus-visible { background: transparent; }
  .popover__panel { position: absolute; z-index: var(--smrt-z-index-popover, 1000); box-sizing: border-box; inline-size: var(--smrt-popover-panel-width, auto); min-width: min(16rem, calc(100vw - 2rem)); max-width: calc(100vw - 2rem); padding: var(--smrt-popover-panel-padding, var(--smrt-spacing-4)); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large); background: var(--smrt-color-surface-container); color: var(--smrt-color-on-surface); box-shadow: var(--smrt-elevation-3); }
  .popover__panel--bottom-start { top: calc(100% + var(--smrt-spacing-1)); left: 0; }
  .popover__panel--bottom-end { top: calc(100% + var(--smrt-spacing-1)); right: 0; }
  .popover__panel--top-start { bottom: calc(100% + var(--smrt-spacing-1)); left: 0; }
  .popover__panel--top-end { right: 0; bottom: calc(100% + var(--smrt-spacing-1)); }
</style>
