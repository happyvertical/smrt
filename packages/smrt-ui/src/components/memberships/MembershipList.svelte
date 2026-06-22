<script lang="ts">
import type { Membership, Role, Tenant } from '@happyvertical/smrt-types';
import { M, useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import MembershipCard from './MembershipCard.svelte';

const { t } = useI18n();

interface MembershipWithContext {
  membership: Membership;
  tenant: Tenant;
  role: Role;
}

interface Props {
  memberships: MembershipWithContext[];
  onremove?: (membership: Membership) => void;
  onchangerole?: (membership: Membership) => void;
  emptyMessage?: string;
  empty?: Snippet;
  loading?: boolean;
}

const {
  memberships,
  onremove,
  onchangerole,
  emptyMessage = 'No memberships found',
  empty,
  loading = false,
}: Props = $props();
</script>

<div class="membership-list">
  {#if loading}
    <div class="loading">
      <div class="spinner"></div>
      <span>{t(M['ui.membership_list.loading'])}</span>
    </div>
  {:else if memberships.length === 0}
    {#if empty}
      {@render empty()}
    {:else}
      <div class="empty">{emptyMessage}</div>
    {/if}
  {:else}
    {#each memberships as { membership, tenant, role } (membership.id)}
      <MembershipCard
        {membership}
        {tenant}
        {role}
        onremove={onremove ? () => onremove(membership) : undefined}
        onchangerole={onchangerole ? () => onchangerole(membership) : undefined}
      />
    {/each}
  {/if}
</div>

<style>
  .membership-list {
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
    color: var(--smrt-color-on-surface-variant);
  }

  .spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full, 9999px);
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
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-variant);
    border: 1px dashed var(--smrt-color-outline);
    border-radius: 0.5rem;
  }
</style>
