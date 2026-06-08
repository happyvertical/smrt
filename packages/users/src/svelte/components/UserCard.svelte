<script lang="ts">
/**
 * UserCard - Compact user information display
 * refactored for Material 3
 */
import type { Profile } from '@happyvertical/smrt-profiles';
import { ripple } from '@happyvertical/smrt-svelte';
import type { User } from '@happyvertical/smrt-users';
import UserAvatar from './UserAvatar.svelte';

export interface Props {
  user: User;
  profile: Profile;
  role?: string;
  status?: string;
  onclick?: () => void;
  selected?: boolean;
}

const {
  user,
  profile,
  role,
  status,
  onclick,
  selected = false,
}: Props = $props();

const statusClass = $derived.by(() => {
  switch (status) {
    case 'active':
      return 'status-active';
    case 'pending':
      return 'status-pending';
    case 'suspended':
      return 'status-error';
    case 'deactivated':
      return 'status-disabled';
    default:
      return '';
  }
});
</script>

<button
  type="button"
  class="user-card"
  class:selected
  class:clickable={!!onclick}
  onclick={onclick}
  disabled={!onclick}
  use:ripple
>
  <UserAvatar {profile} size="md" />

  <div class="info">
    <div class="name">{profile.name}</div>
    <div class="email">{user.email}</div>
  </div>

  <div class="meta">
    {#if role}
      <span class="role">{role}</span>
    {/if}
    {#if status}
      <span class="status {statusClass}">{status}</span>
    {/if}
  </div>
</button>

<style>
  .user-card {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4, 16px);
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-4, 16px);
    background-color: var(--smrt-color-surface-container-low);
    border-radius: 12px;
    width: 100%;
    text-align: left;
    cursor: default;
    border: none;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    position: relative;
    overflow: hidden;
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-level1);
  }

  .user-card.clickable {
    cursor: pointer;
  }

  .user-card.clickable:hover {
    background-color: var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-level2);
  }

  .user-card.selected {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }

  .info {
    flex: 1;
    min-width: 0;
  }

  .name {
    font: var(--smrt-typography-title-small-font);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .email {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .selected .email {
    color: var(--smrt-color-on-secondary-container);
    opacity: 0.8;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    flex-shrink: 0;
  }

  .role {
    font: var(--smrt-typography-label-small-font);
    padding: 0 var(--smrt-spacing-2, 8px);
    height: 20px;
    display: inline-flex;
    align-items: center;
    background-color: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface-variant);
    border-radius: 10px;
    text-transform: capitalize;
  }

  .status {
    font: var(--smrt-typography-label-small-font);
    padding: 0 var(--smrt-spacing-2, 8px);
    height: 20px;
    display: inline-flex;
    align-items: center;
    border-radius: 10px;
    text-transform: capitalize;
    font-weight: 600;
  }

  .status-active {
    background-color: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .status-pending {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }

  .status-error {
    background-color: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .status-disabled {
    background-color: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
</style>