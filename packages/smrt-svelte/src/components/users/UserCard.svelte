<script lang="ts">
/**
 * UserCard - Compact user information display
 * refactored for Material 3
 */
import type { Profile } from '@happyvertical/smrt-profiles';
import type { User } from '@happyvertical/smrt-users';
import { ripple } from '../../actions/ripple.js';
import UserAvatar from './UserAvatar.svelte';

interface Props {
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
    gap: 16px;
    padding: 12px 16px;
    background-color: var(--md-sys-color-surface-container-low);
    border-radius: 12px;
    width: 100%;
    text-align: left;
    cursor: default;
    border: none;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    position: relative;
    overflow: hidden;
    color: var(--md-sys-color-on-surface);
    box-shadow: var(--md-sys-elevation-level1);
  }

  .user-card.clickable {
    cursor: pointer;
  }

  .user-card.clickable:hover {
    background-color: var(--md-sys-color-surface-container-high);
    box-shadow: var(--md-sys-elevation-level2);
  }

  .user-card.selected {
    background-color: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }

  .info {
    flex: 1;
    min-width: 0;
  }

  .name {
    font: var(--md-sys-typescale-title-small-font);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .email {
    font: var(--md-sys-typescale-body-small-font);
    color: var(--md-sys-color-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .selected .email {
    color: var(--md-sys-color-on-secondary-container);
    opacity: 0.8;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .role {
    font: var(--md-sys-typescale-label-small-font);
    padding: 0 8px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    background-color: var(--md-sys-color-surface-container-highest);
    color: var(--md-sys-color-on-surface-variant);
    border-radius: 10px;
    text-transform: capitalize;
  }

  .status {
    font: var(--md-sys-typescale-label-small-font);
    padding: 0 8px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    border-radius: 10px;
    text-transform: capitalize;
    font-weight: 600;
  }

  .status-active {
    background-color: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
  }

  .status-pending {
    background-color: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
  }

  .status-error {
    background-color: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }

  .status-disabled {
    background-color: var(--md-sys-color-surface-variant);
    color: var(--md-sys-color-on-surface-variant);
  }
</style>