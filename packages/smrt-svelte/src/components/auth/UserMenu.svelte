<script lang="ts">
/**
 * UserMenu - User profile menu dropdown
 * refactored for Material 3
 *
 * Accessibility:
 * - Proper ARIA attributes for menu state
 * - Keyboard navigation (Escape to close)
 * - Click outside to close
 * - Focus management
 */
import type { Profile } from '@happyvertical/smrt-profiles';
import { ripple } from '../../actions/ripple.js';

/** Props for the UserMenu component */
export interface Props {
  /** Full SMRT profile object */
  profile?: Profile;
  /** Simple user object (used when profile is not available) */
  user?: { name: string; email?: string };
  /** URL for sign out */
  signoutUrl?: string;
  /** URL for profile page */
  profileUrl?: string;
  /** URL for settings page */
  settingsUrl?: string;
  /** Accessible label for the menu button */
  'aria-label'?: string;
}

const {
  profile,
  user,
  signoutUrl = '/auth/signout',
  profileUrl = '/profile',
  settingsUrl = '/settings',
  'aria-label': ariaLabel = 'User menu',
}: Props = $props();

const displayName = $derived(profile?.name ?? user?.name ?? 'User');
const userEmail = $derived(profile?.email ?? user?.email);

let open = $state(false);
let triggerButton: HTMLButtonElement;
let menuId = $state(`user-menu-${Math.random().toString(36).slice(2, 9)}`);

function toggle() {
  open = !open;
  if (!open && triggerButton) {
    triggerButton.focus();
  }
}

function close() {
  if (open) {
    open = false;
    // Return focus to trigger button
    triggerButton?.focus();
  }
}

/**
 * Handle keyboard navigation
 */
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open) {
    event.preventDefault();
    close();
  }
}

/**
 * Handle click outside to close menu
 */
function handleClickOutside(event: MouseEvent) {
  const target = event.target as Node;
  const menu = document.getElementById(menuId);
  if (menu && !menu.contains(target) && !triggerButton.contains(target)) {
    close();
  }
}

/**
 * Get initials from name
 */
function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
</script>

<svelte:window onclick={handleClickOutside} onkeydown={handleKeydown} />

<div class="user-menu" id={menuId}>
  <button 
    bind:this={triggerButton}
    class="user-menu-trigger" 
    onclick={toggle} 
    type="button"
    use:ripple
    aria-haspopup="true"
    aria-expanded={open}
    aria-label={ariaLabel}
  >
    <span class="avatar" aria-hidden="true">
      {getInitials(displayName)}
    </span>
    <span class="user-name">{displayName}</span>
    <svg class="chevron" class:open viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
    </svg>
  </button>

  {#if open}
    <div 
      class="dropdown"
      role="menu"
      aria-orientation="vertical"
    >
      {#if userEmail}
        <div class="user-info" role="none">
          <span class="user-info-name">{displayName}</span>
          <span class="user-info-email">{userEmail}</span>
        </div>
        <hr class="divider" />
      {/if}
      
      <a 
        href={profileUrl} 
        class="dropdown-item" 
        onclick={close} 
        use:ripple
        role="menuitem"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" />
        </svg>
        Profile
      </a>
      <a 
        href={settingsUrl} 
        class="dropdown-item" 
        onclick={close} 
        use:ripple
        role="menuitem"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
        </svg>
        Settings
      </a>
      <hr class="divider" />
      <a 
        href={signoutUrl} 
        class="dropdown-item danger" 
        onclick={close} 
        use:ripple
        role="menuitem"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fill-rule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clip-rule="evenodd" />
        </svg>
        Sign out
      </a>
    </div>
  {/if}
</div>

<style>
  .user-menu {
    position: relative;
    display: inline-block;
  }

  .user-menu-trigger {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 20px;
    cursor: pointer;
    transition: background-color 200ms;
    color: var(--md-sys-color-on-surface);
    position: relative;
    overflow: hidden;
  }

  .user-menu-trigger:hover {
    background-color: var(--md-sys-color-surface-container-high);
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background-color: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
    font: var(--md-sys-typescale-label-large-font);
    font-weight: 600;
  }

  .user-name {
    font: var(--md-sys-typescale-label-large-font);
    font-weight: 500;
  }

  .chevron {
    width: 18px;
    height: 18px;
    transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
    opacity: 0.7;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 200px;
    background-color: var(--md-sys-color-surface-container);
    border-radius: 4px;
    box-shadow: var(--md-sys-elevation-level2);
    z-index: 50;
    padding: 4px 0;
    overflow: hidden;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    font: var(--md-sys-typescale-body-medium-font);
    color: var(--md-sys-color-on-surface);
    text-decoration: none;
    transition: background-color 200ms;
    position: relative;
    overflow: hidden;
  }

  .dropdown-item:hover {
    background-color: var(--md-sys-color-surface-container-highest);
  }

  .dropdown-item svg {
    width: 18px;
    height: 18px;
    opacity: 0.7;
  }

  .dropdown-item.danger {
    color: var(--md-sys-color-error);
  }

  .user-info {
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .user-info-name {
    font: var(--md-sys-typescale-body-medium-font);
    font-weight: 500;
    color: var(--md-sys-color-on-surface);
  }

  .user-info-email {
    font: var(--md-sys-typescale-body-small-font);
    color: var(--md-sys-color-on-surface-variant);
  }

  .user-menu-trigger:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
  }

  .dropdown-item:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: -2px;
  }

  .divider {
    margin: 4px 0;
    border: none;
    border-top: 1px solid var(--md-sys-color-outline-variant);
  }
</style>