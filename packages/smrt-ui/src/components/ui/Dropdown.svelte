<script lang="ts">
/**
 * Dropdown / Menu — a trigger button and a positioned menu list.
 *
 * Implements the WAI-ARIA menu-button pattern: trigger has
 * `aria-haspopup="menu"` + `aria-expanded`; the list is `role="menu"` with
 * `role="menuitem"` buttons under roving focus (ArrowUp/Down/Home/End), Enter/
 * Space to activate, Escape to close + refocus the trigger, and click-outside to
 * dismiss. CSS-anchored via `placement` — no JS positioning dependency.
 */

import type { Snippet } from 'svelte';
import { tick } from 'svelte';
import type { DropdownPlacement, MenuItem } from '../../types-generic';

export interface Props {
  /** Trigger button text (ignored when a `trigger` snippet is given). */
  label?: string;
  /** Custom trigger content. */
  trigger?: Snippet;
  /** Accessible name of the trigger button when it shows only an icon (`aria-label`); omit to use its visible content (an icon trigger then falls back to `label`). */
  triggerLabel?: string;
  /**
   * Trigger look: `button` (bordered, the default) or `icon`, a borderless 44px
   * round icon button (a "more" or row-actions menu) that takes the surrounding
   * text colour.
   */
  variant?: 'button' | 'icon';
  /** Menu items. */
  items: MenuItem[];
  /** Menu placement relative to the trigger. */
  placement?: DropdownPlacement;
  /** Fired with the activated item's id. */
  onselect?: (id: string) => void;
  /** Disable the trigger. */
  disabled?: boolean;
}

const {
  label,
  trigger,
  triggerLabel,
  variant = 'button',
  items,
  placement = 'bottom-start',
  onselect,
  disabled = false,
}: Props = $props();

const instanceId = $props.id();
const menuId = `smrt-menu-${instanceId}`;

// An icon trigger shows no text, so without triggerLabel or label the button
// has no accessible name.
$effect(() => {
  if (variant === 'icon' && !triggerLabel && !label) {
    console.warn(
      '[Dropdown] variant="icon" needs triggerLabel (or label): the trigger button has no accessible name.',
    );
  }
});
let open = $state(false);
let wrapEl = $state<HTMLElement | null>(null);
let triggerEl = $state<HTMLButtonElement | null>(null);
let itemEls = $state<Array<HTMLButtonElement | null>>([]);

const enabledIndexes = $derived(
  items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0),
);

async function openMenu(focusLast = false) {
  open = true;
  await tick();
  const target = focusLast
    ? enabledIndexes[enabledIndexes.length - 1]
    : enabledIndexes[0];
  if (target != null) itemEls[target]?.focus();
}

function closeMenu(refocus = true) {
  open = false;
  if (refocus) triggerEl?.focus();
}

function selectItem(item: MenuItem) {
  if (item.disabled) return;
  item.onselect?.();
  onselect?.(item.id);
  closeMenu();
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openMenu();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu(true);
  }
}

function focusByOffset(offset: number) {
  const order = enabledIndexes;
  if (order.length === 0) return;
  const current = itemEls.indexOf(document.activeElement as HTMLButtonElement);
  const pos = order.indexOf(current);
  const next = order[(pos + offset + order.length) % order.length];
  itemEls[next]?.focus();
}

function onMenuKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusByOffset(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      focusByOffset(-1);
      break;
    case 'Home':
      event.preventDefault();
      itemEls[enabledIndexes[0]]?.focus();
      break;
    case 'End':
      event.preventDefault();
      itemEls[enabledIndexes[enabledIndexes.length - 1]]?.focus();
      break;
    case 'Escape':
      event.preventDefault();
      closeMenu();
      break;
    case 'Tab':
      closeMenu(false);
      break;
  }
}

// Dismiss on outside click while open.
$effect(() => {
  if (!open) return;
  const onDocPointer = (event: MouseEvent) => {
    if (wrapEl && !wrapEl.contains(event.target as Node)) closeMenu(false);
  };
  document.addEventListener('click', onDocPointer, true);
  return () => document.removeEventListener('click', onDocPointer, true);
});
</script>

<span class="smrt-dropdown__root" bind:this={wrapEl} data-smrt-component="Dropdown">
  <button
    bind:this={triggerEl}
    type="button"
    class="smrt-dropdown__trigger"
    class:smrt-dropdown__trigger-icon={variant === 'icon'}
    data-smrt-part="trigger"
    aria-label={triggerLabel ?? (variant === 'icon' ? label : undefined)}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? menuId : undefined}
    {disabled}
    onclick={() => (open ? closeMenu(false) : openMenu())}
    onkeydown={onTriggerKeydown}
  >
    {#if trigger}{@render trigger()}{:else}{label}{/if}
  </button>

  {#if open}
    <div
      id={menuId}
      role="menu"
      tabindex={-1}
      class="smrt-dropdown__menu smrt-dropdown__menu-{placement}"
      data-smrt-part="panel"
      onkeydown={onMenuKeydown}
    >
      {#each items as item, i (item.id)}
        <button
          bind:this={itemEls[i]}
          type="button"
          role="menuitem"
          class="smrt-dropdown__item"
          data-smrt-part="item"
          disabled={item.disabled}
          tabindex={-1}
          onclick={() => selectItem(item)}
        >
          {#if item.icon}
            <span class="smrt-dropdown__icon" data-smrt-part="icon" aria-hidden="true">{@render item.icon()}</span>
          {/if}
          <span class="smrt-dropdown__label" data-smrt-part="label">{item.label}</span>
        </button>
      {/each}
    </div>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-dropdown__root {
    position: relative;
    display: inline-flex;
  }
  .smrt-dropdown__trigger {
    cursor: pointer;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  /* Icon trigger: a 44px round "more" button in the surrounding text colour. */
  .smrt-dropdown__trigger-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    padding: 0;
  }
  .smrt-dropdown__trigger:disabled {
    cursor: not-allowed;
  }
  .smrt-dropdown__menu {
    position: absolute;
    z-index: var(--smrt-z-index-dropdown, 1000);
    min-width: 10rem;
    margin: var(--smrt-spacing-1) 0;
    padding: var(--smrt-spacing-1);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  .smrt-dropdown__menu-bottom-start {
    top: 100%;
    left: 0;
  }
  .smrt-dropdown__menu-bottom-end {
    top: 100%;
    right: 0;
  }
  .smrt-dropdown__menu-top-start {
    bottom: 100%;
    left: 0;
  }
  .smrt-dropdown__menu-top-end {
    bottom: 100%;
    right: 0;
  }
  .smrt-dropdown__item {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    /* A touch target: menu rows are at least 44px tall. */
    min-block-size: 2.75rem;
    box-sizing: border-box;
    cursor: pointer;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    white-space: nowrap;
  }
  .smrt-dropdown__icon {
    display: inline-flex;
    flex: none;
  }
  .smrt-dropdown__item:disabled {
    cursor: not-allowed;
  }
}

@layer smrt.theme {
  .smrt-dropdown__trigger {
    appearance: none;
    font: inherit;
    border-radius: var(--smrt-control-radius);
    border: var(--smrt-hairline-strong);
    background: var(--smrt-surface-control);
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-control-weight);
  }
  .smrt-dropdown__trigger:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  /* Icon trigger: a 44px round "more" button in the surrounding text colour. */
  .smrt-dropdown__trigger-icon {
    border: none;
    border-radius: var(--smrt-radius-full);
    background: transparent;
    color: inherit;
  }
  .smrt-dropdown__trigger-icon:hover:not(:disabled),
  .smrt-dropdown__trigger-icon[aria-expanded='true'] {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
  .smrt-dropdown__trigger:disabled {
    opacity: var(--smrt-state-disabled);
  }
  .smrt-dropdown__menu {
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-glass-surface-strong);
    backdrop-filter: blur(var(--smrt-glass-blur)) saturate(var(--smrt-glass-saturation));
    border: var(--smrt-hairline);
    box-shadow: var(--smrt-inset-highlight), var(--smrt-elevation-3);
  }
  .smrt-dropdown__item {
    appearance: none;
    font: inherit;
    text-align: left;
    border: none;
    border-radius: var(--smrt-radius-small);
    background: none;
    color: var(--smrt-color-on-surface);
  }
  .smrt-dropdown__icon {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-dropdown__item:hover:not(:disabled) {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
  .smrt-dropdown__item:active:not(:disabled) {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-pressed) * 100%), transparent);
  }
  /* Keyboard focus needs its own indicator: the hover background alone is a
  ~1.1:1 change against the menu surface in every preset (1.00:1 in glass
  light), which is invisible and fails WCAG 2.4.11. The ring is inset so it
  sits inside the item's padding box rather than overlapping the neighbouring
  item or the menu's edge (#2322). */
  .smrt-dropdown__item:focus-visible {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: calc(var(--smrt-focus-ring-width) * -1);
  }
  .smrt-dropdown__item:disabled {
    opacity: var(--smrt-state-disabled);
  }
}

</style>
