<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';

interface Props {
  profile: Profile;
  signoutUrl?: string;
  profileUrl?: string;
  settingsUrl?: string;
}

const {
  profile,
  signoutUrl = '/auth/signout',
  profileUrl = '/profile',
  settingsUrl = '/settings',
}: Props = $props();

let open = $state(false);

function toggle() {
  open = !open;
}

function close() {
  open = false;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
</script>

<div class="user-menu" onmouseleave={close}>
  <button class="user-menu-trigger" onclick={toggle} type="button">
    <span class="avatar">
      {getInitials(profile.name ?? 'U')}
    </span>
    <span class="user-name">{profile.name}</span>
    <svg class="chevron" class:open viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
    </svg>
  </button>

  {#if open}
    <div class="dropdown">
      <a href={profileUrl} class="dropdown-item" onclick={close}>
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" />
        </svg>
        Profile
      </a>
      <a href={settingsUrl} class="dropdown-item" onclick={close}>
        <svg viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd" />
        </svg>
        Settings
      </a>
      <hr class="divider" />
      <a href={signoutUrl} class="dropdown-item danger">
        <svg viewBox="0 0 20 20" fill="currentColor">
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
    gap: 0.5rem;
    padding: 0.5rem;
    background: transparent;
    border: none;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  .user-menu-trigger:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.05));
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 9999px;
    background: var(--avatar-bg, #3b82f6);
    color: white;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .user-name {
    font-size: 0.875rem;
    font-weight: 500;
  }

  .chevron {
    width: 1rem;
    height: 1rem;
    transition: transform 0.15s;
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 0.25rem;
    min-width: 12rem;
    background: var(--dropdown-bg, white);
    border: 1px solid var(--border-color, #e2e8f0);
    border-radius: 0.5rem;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    z-index: 50;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    color: var(--text-color, #1f2937);
    text-decoration: none;
    transition: background-color 0.15s;
  }

  .dropdown-item:hover {
    background: var(--hover-bg, rgba(0, 0, 0, 0.05));
  }

  .dropdown-item svg {
    width: 1rem;
    height: 1rem;
    opacity: 0.5;
  }

  .dropdown-item.danger {
    color: var(--danger-color, #dc2626);
  }

  .divider {
    margin: 0.25rem 0;
    border: none;
    border-top: 1px solid var(--border-color, #e2e8f0);
  }
</style>
