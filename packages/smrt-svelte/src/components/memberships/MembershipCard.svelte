<script lang="ts">
import type { Membership, Role, Tenant } from '@happyvertical/smrt-users';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import RoleBadge from '../roles/RoleBadge.svelte';

const { t } = useI18n();

interface Props {
  membership: Membership;
  tenant: Tenant;
  role: Role;
  onremove?: () => void;
  onchangerole?: () => void;
}

const { membership, tenant, role, onremove, onchangerole }: Props = $props();

function getStatusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'status-active';
    case 'pending':
      return 'status-pending';
    case 'suspended':
      return 'status-suspended';
    default:
      return '';
  }
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
</script>

<div class="membership-card">
  <div class="main">
    <div class="tenant-info">
      <span class="tenant-name">{tenant.name}</span>
      <span class="status {getStatusColor(membership.status)}">{membership.status}</span>
    </div>

    <div class="role-info">
      <RoleBadge {role} />
    </div>
  </div>

  <div class="meta">
    <span class="date">Joined {formatDate(membership.created_at)}</span>

    {#if onchangerole || onremove}
      <div class="actions">
        {#if onchangerole}
          <button type="button" class="action-btn" onclick={onchangerole}>{t(M['ui.membership_card.change_role'])}</button>
        {/if}
        {#if onremove}
          <button type="button" class="action-btn danger" onclick={onremove}>Remove</button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .membership-card {
    padding: 1rem;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.5rem;
  }

  .main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .tenant-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .tenant-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }

  .status {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    padding: 0.125rem 0.375rem;
    border-radius: var(--smrt-radius-full, 9999px);
    text-transform: uppercase;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .status-active {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .status-pending {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }

  .status-suspended {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .role-info {
    flex-shrink: 0;
  }

  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .date {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .action-btn {
    padding: 0.25rem 0.5rem;
    background: none;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.25rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }

  .action-btn:hover {
    background: var(--smrt-color-surface-container);
  }

  .action-btn.danger {
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }

  .action-btn.danger:hover {
    background: var(--smrt-color-error-container);
  }
</style>
