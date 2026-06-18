<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import type { User } from '@happyvertical/smrt-users';
import type { Snippet } from 'svelte';
import { M } from '../i18n.js';
import UserCard from './UserCard.svelte';

const { t } = useI18n();

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
      <span>{t(M['users.user_list.loading_users'])}</span>
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
    gap: var(--smrt-spacing-sm, 0.5rem);
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-sm, 0.75rem);
    padding: var(--smrt-spacing-xl, 2rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-top-color: var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-full, 9999px);
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .empty {
    padding: var(--smrt-spacing-xl, 2rem);
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border: 1px dashed var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
