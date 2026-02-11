<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';
import type { User } from '@happyvertical/smrt-users';
import type { Snippet } from 'svelte';
import UserCard from './UserCard.svelte';

interface UserWithProfile {
  user: User;
  profile: Profile;
  role?: string;
}

export interface Props {
  users: UserWithProfile[];
  selectedId?: string | null;
  onselect?: (user: User) => void;
  emptyMessage?: string;
  empty?: Snippet;
  loading?: boolean;
}

const {
  users,
  selectedId = null,
  onselect,
  emptyMessage = 'No users found',
  empty,
  loading = false,
}: Props = $props();
</script>

<div class="user-list">
  {#if loading}
    <div class="loading">
      <div class="spinner"></div>
      <span>Loading users...</span>
    </div>
  {:else if users.length === 0}
    {#if empty}
      {@render empty()}
    {:else}
      <div class="empty">{emptyMessage}</div>
    {/if}
  {:else}
    {#each users as { user, profile, role } (user.id)}
      <UserCard
        {user}
        {profile}
        {role}
        status={user.status}
        selected={selectedId === user.id}
        onclick={onselect ? () => onselect(user) : undefined}
      />
    {/each}
  {/if}
</div>

<style>
  .user-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2rem;
    color: #6b7280;
  }

  .spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid #e5e7eb;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .empty {
    padding: 2rem;
    text-align: center;
    color: #6b7280;
    background: #f9fafb;
    border: 1px dashed #d1d5db;
    border-radius: 0.5rem;
  }
</style>
