<script lang="ts">
import type { Membership, Role, Tenant } from '@happyvertical/smrt-users';
import RoleBadge from '../roles/RoleBadge.svelte';

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
          <button type="button" class="action-btn" onclick={onchangerole}>Change Role</button>
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
    background: white;
    border: 1px solid #e5e7eb;
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
    font-weight: 500;
    color: #111827;
  }

  .status {
    font-size: 0.625rem;
    padding: 0.125rem 0.375rem;
    border-radius: 9999px;
    text-transform: uppercase;
    font-weight: 600;
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

  .role-info {
    flex-shrink: 0;
  }

  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #f3f4f6;
  }

  .date {
    font-size: 0.75rem;
    color: #6b7280;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
  }

  .action-btn {
    padding: 0.25rem 0.5rem;
    background: none;
    border: 1px solid #d1d5db;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    color: #374151;
    cursor: pointer;
  }

  .action-btn:hover {
    background: #f3f4f6;
  }

  .action-btn.danger {
    color: #dc2626;
    border-color: #fecaca;
  }

  .action-btn.danger:hover {
    background: #fef2f2;
  }
</style>
