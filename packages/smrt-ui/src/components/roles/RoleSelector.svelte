<script lang="ts">
/**
 * RoleSelector — a trigger button and a single-select listbox of roles.
 *
 * Implements keyboard support per the WAI-ARIA listbox pattern, mirroring the
 * roving-focus approach in `ui/Dropdown.svelte`: the trigger opens on
 * ArrowDown/ArrowUp/Enter/Space; the open list moves focus onto the selected
 * (or first) option; ArrowUp/Down/Home/End move roving focus; Enter/Space pick
 * the focused option; Escape closes and refocuses the trigger; Tab closes.
 * Click-outside also dismisses.
 */

import type { Role } from '@happyvertical/smrt-types';
import { tick } from 'svelte';

export interface Props {
  roles: Role[];
  value?: string | null;
  onchange: (roleId: string) => void;
  disabled?: boolean;
  placeholder?: string;
  showDescription?: boolean;
}

const {
  roles,
  value = null,
  onchange,
  disabled = false,
  placeholder = 'Select a role',
  showDescription = false,
}: Props = $props();

let open = $state(false);
let wrapEl = $state<HTMLElement | null>(null);
let triggerEl = $state<HTMLButtonElement | null>(null);
let optionEls = $state<Array<HTMLButtonElement | null>>([]);
const selectedRole = $derived(roles.find((r) => r.id === value));

async function openList() {
  if (disabled || roles.length === 0) return;
  open = true;
  await tick();
  // Focus the selected option if there is one, otherwise the first.
  const selectedIndex = roles.findIndex((r) => r.id === value);
  const target = selectedIndex >= 0 ? selectedIndex : 0;
  optionEls[target]?.focus();
}

function closeList(refocus = true) {
  open = false;
  if (refocus) triggerEl?.focus();
}

function handleSelect(roleId: string) {
  onchange(roleId);
  closeList();
}

function focusByOffset(offset: number) {
  if (roles.length === 0) return;
  const current = optionEls.indexOf(
    document.activeElement as HTMLButtonElement | null,
  );
  const from = current < 0 ? 0 : current;
  const next = (from + offset + roles.length) % roles.length;
  optionEls[next]?.focus();
}

function onTriggerKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openList();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    openList();
  }
}

function onListKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusByOffset(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      focusByOffset(-1);
      break;
    case 'Home':
      e.preventDefault();
      optionEls[0]?.focus();
      break;
    case 'End':
      e.preventDefault();
      optionEls[roles.length - 1]?.focus();
      break;
    case 'Escape':
      e.preventDefault();
      closeList();
      break;
    case 'Tab':
      closeList(false);
      break;
  }
}

// Dismiss on outside click while open.
$effect(() => {
  if (!open) return;
  const onDocPointer = (event: MouseEvent) => {
    if (wrapEl && !wrapEl.contains(event.target as Node)) closeList(false);
  };
  document.addEventListener('click', onDocPointer, true);
  return () => document.removeEventListener('click', onDocPointer, true);
});
</script>

<div class="role-selector" class:disabled bind:this={wrapEl}>
  <button
    bind:this={triggerEl}
    type="button"
    class="trigger"
    class:open
    onclick={() => (open ? closeList(false) : openList())}
    onkeydown={onTriggerKeydown}
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    {#if selectedRole}
      <span class="selected">
        <span class="role-name">{selectedRole.name}</span>
        {#if selectedRole.isSystem}
          <span class="system-badge">System</span>
        {/if}
      </span>
    {:else}
      <span class="placeholder">{placeholder}</span>
    {/if}
    <svg class="chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fill-rule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clip-rule="evenodd"
      />
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="dropdown"
      role="listbox"
      tabindex={-1}
      aria-label={placeholder}
      onkeydown={onListKeydown}
    >
      {#each roles as role, i (role.id)}
        <button
          bind:this={optionEls[i]}
          type="button"
          class="option"
          class:selected={role.id === value}
          onclick={() => handleSelect(role.id!)}
          role="option"
          tabindex={-1}
          aria-selected={role.id === value}
        >
          <div class="option-content">
            <span class="role-name">{role.name}</span>
            {#if role.isSystem}
              <span class="system-badge">System</span>
            {/if}
          </div>
          {#if showDescription && role.description}
            <span class="description">{role.description}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .role-selector {
    position: relative;
    width: 100%;
  }

  .role-selector.disabled {
    opacity: 0.6;
  }

  .trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--smrt-color-surface, white);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 0.375rem);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    cursor: pointer;
    text-align: left;
  }

  .trigger:focus-visible {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
  }

  .trigger.open {
    border-color: var(--smrt-color-primary, #005ac1);
  }

  .trigger:disabled {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    cursor: not-allowed;
  }

  .selected {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .placeholder {
    color: var(--smrt-color-on-surface-variant, #9ca3af);
  }

  .chevron {
    width: 1.25rem;
    height: 1.25rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    transition: transform var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .trigger.open .chevron {
    transform: rotate(180deg);
  }

  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 0.25rem;
    background: var(--smrt-color-surface, white);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-radius: var(--smrt-radius-small, 0.375rem);
    box-shadow: var(--smrt-elevation-2, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
    z-index: var(--smrt-z-index-dropdown, 1000);
    max-height: 15rem;
    overflow-y: auto;
  }

  .option {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    cursor: pointer;
    text-align: left;
  }

  .option:hover,
  .option:focus-visible {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    outline: none;
  }

  .option.selected {
    background: var(--smrt-color-primary-container, #eff6ff);
  }

  .option-content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .role-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #111827);
    text-transform: capitalize;
  }

  .system-badge {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    padding: 0.125rem 0.375rem;
    background: var(--smrt-color-primary-container, #dbeafe);
    color: var(--smrt-color-on-primary-container, #1e40af);
    border-radius: var(--smrt-radius-full, 9999px);
    text-transform: uppercase;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .description {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }
</style>
