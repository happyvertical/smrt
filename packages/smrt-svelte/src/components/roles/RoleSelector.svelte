<script lang="ts">
import type { Role } from '@happyvertical/smrt-users';

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
const selectedRole = $derived(roles.find((r) => r.id === value));

function handleSelect(roleId: string) {
  onchange(roleId);
  open = false;
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    open = false;
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="role-selector" class:disabled>
  <button
    type="button"
    class="trigger"
    class:open
    onclick={() => (open = !open)}
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
    <svg class="chevron" viewBox="0 0 20 20" fill="currentColor">
      <path
        fill-rule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clip-rule="evenodd"
      />
    </svg>
  </button>

  {#if open}
    <div class="dropdown" role="listbox">
      {#each roles as role (role.id)}
        <button
          type="button"
          class="option"
          class:selected={role.id === value}
          onclick={() => handleSelect(role.id!)}
          role="option"
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
    font-size: 0.875rem;
    cursor: pointer;
    text-align: left;
  }

  .trigger:focus {
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
    font-size: 0.875rem;
    cursor: pointer;
    text-align: left;
  }

  .option:hover {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
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
    font-weight: 500;
    color: var(--smrt-color-on-surface, #111827);
    text-transform: capitalize;
  }

  .system-badge {
    font-size: 0.625rem;
    padding: 0.125rem 0.375rem;
    background: var(--smrt-color-primary-container, #dbeafe);
    color: var(--smrt-color-on-primary-container, #1e40af);
    border-radius: var(--smrt-radius-full, 9999px);
    text-transform: uppercase;
    font-weight: 600;
  }

  .description {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }
</style>
