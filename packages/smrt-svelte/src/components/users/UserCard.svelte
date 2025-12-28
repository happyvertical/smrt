<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';
import type { User } from '@happyvertical/smrt-users';
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

function getStatusColor(s: string): string {
  switch (s) {
    case 'active':
      return 'status-active';
    case 'pending':
      return 'status-pending';
    case 'suspended':
      return 'status-suspended';
    case 'deactivated':
      return 'status-deactivated';
    default:
      return '';
  }
}
</script>

<button
  type="button"
  class="user-card"
  class:selected
  class:clickable={!!onclick}
  onclick={onclick}
  disabled={!onclick}
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
      <span class="status {getStatusColor(status)}">{status}</span>
    {/if}
  </div>
</button>

<style>
  .user-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    width: 100%;
    text-align: left;
    cursor: default;
  }

  .user-card.clickable {
    cursor: pointer;
  }

  .user-card.clickable:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }

  .user-card.selected {
    background: #eff6ff;
    border-color: #3b82f6;
  }

  .info {
    flex: 1;
    min-width: 0;
  }

  .name {
    font-weight: 500;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .email {
    font-size: 0.875rem;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .role {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: #f3f4f6;
    color: #374151;
    border-radius: 9999px;
    text-transform: capitalize;
  }

  .status {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    border-radius: 9999px;
    text-transform: capitalize;
  }

  .status-active {
    background: #dcfce7;
    color: #166534;
  }

  .status-pending {
    background: #fef3c7;
    color: #92400e;
  }

  .status-suspended {
    background: #fee2e2;
    color: #991b1b;
  }

  .status-deactivated {
    background: #f3f4f6;
    color: #6b7280;
  }
</style>
