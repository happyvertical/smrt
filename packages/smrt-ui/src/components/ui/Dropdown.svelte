<script module lang="ts">
let menuIdCounter = 0;
</script>

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
import { tick } from 'svelte';
import type { Snippet } from 'svelte';
import type { DropdownPlacement, MenuItem } from '../../types-generic';

export interface Props {
  /** Trigger button text (ignored when a `trigger` snippet is given). */
  label?: string;
  /** Custom trigger content. */
  trigger?: Snippet;
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
  items,
  placement = 'bottom-start',
  onselect,
  disabled = false,
}: Props = $props();

const menuId = `smrt-menu-${(menuIdCounter += 1)}`;
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
  const current = itemEls.findIndex((el) => el === document.activeElement);
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

<span class="dropdown" bind:this={wrapEl}>
  <button
    bind:this={triggerEl}
    type="button"
    class="dropdown__trigger"
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
      class="dropdown__menu dropdown__menu--{placement}"
      onkeydown={onMenuKeydown}
    >
      {#each items as item, i (item.id)}
        <button
          bind:this={itemEls[i]}
          type="button"
          role="menuitem"
          class="dropdown__item"
          disabled={item.disabled}
          tabindex={-1}
          onclick={() => selectItem(item)}
        >
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</span>

<style>
  .dropdown {
    position: relative;
    display: inline-flex;
  }

  .dropdown__trigger {
    appearance: none;
    font: inherit;
    cursor: pointer;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-medium, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .dropdown__trigger:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  .dropdown__trigger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .dropdown__menu {
    position: absolute;
    z-index: var(--smrt-z-index-dropdown, 1000);
    min-width: 10rem;
    margin: var(--smrt-spacing-1, 4px) 0;
    padding: var(--smrt-spacing-1, 4px);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-surface-container, #f3edf7);
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    box-shadow: var(--smrt-elevation-2, 0 2px 6px rgba(0, 0, 0, 0.15));
  }

  .dropdown__menu--bottom-start {
    top: 100%;
    left: 0;
  }
  .dropdown__menu--bottom-end {
    top: 100%;
    right: 0;
  }
  .dropdown__menu--top-start {
    bottom: 100%;
    left: 0;
  }
  .dropdown__menu--top-end {
    bottom: 100%;
    right: 0;
  }

  .dropdown__item {
    appearance: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border: none;
    border-radius: var(--smrt-radius-small, 4px);
    background: none;
    color: var(--smrt-color-on-surface);
    white-space: nowrap;
  }
  .dropdown__item:hover:not(:disabled),
  .dropdown__item:focus-visible {
    background: var(--smrt-color-surface-container-high);
    outline: none;
  }
  .dropdown__item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
