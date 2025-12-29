<script lang="ts">
import type { Tenant } from '@happyvertical/smrt-users';

interface Props {
  tenant: Tenant;
  memberCount?: number;
  onclick?: () => void;
  selected?: boolean;
  actions?: boolean;
  onedit?: () => void;
  ondelete?: () => void;
}

const {
  tenant,
  memberCount,
  onclick,
  selected = false,
  actions = false,
  onedit,
  ondelete,
}: Props = $props();

function getStatusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'status-active';
    case 'suspended':
      return 'status-suspended';
    case 'archived':
      return 'status-archived';
    default:
      return '';
  }
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getColor(name: string): string {
  const colors = [
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
    '#f97316',
    '#22c55e',
    '#06b6d4',
    '#6366f1',
    '#14b8a6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
</script>

<div
  class="tenant-card"
  class:clickable={!!onclick}
  class:selected
  role={onclick ? 'button' : undefined}
  tabindex={onclick ? 0 : undefined}
  onclick={onclick}
  onkeydown={(e) => e.key === 'Enter' && onclick?.()}
>
  <div class="avatar" style:background-color={getColor(tenant.name ?? '')}>
    {getInitials(tenant.name ?? 'T')}
  </div>

  <div class="info">
    <div class="header">
      <span class="name">{tenant.name}</span>
      <span class="status {getStatusColor(tenant.status)}">{tenant.status}</span>
    </div>

    {#if tenant.slug}
      <div class="slug">{tenant.slug}</div>
    {/if}

    {#if memberCount !== undefined}
      <div class="meta">
        <span class="members">{memberCount} member{memberCount === 1 ? '' : 's'}</span>
      </div>
    {/if}
  </div>

  {#if actions && (onedit || ondelete)}
    <div class="actions">
      {#if onedit}
        <button type="button" class="action-btn" onclick|stopPropagation={onedit}>
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path
              d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z"
            />
          </svg>
        </button>
      {/if}
      {#if ondelete}
        <button type="button" class="action-btn danger" onclick|stopPropagation={ondelete}>
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path
              fill-rule="evenodd"
              d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
              clip-rule="evenodd"
            />
          </svg>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tenant-card {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 1rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
  }

  .tenant-card.clickable {
    cursor: pointer;
  }

  .tenant-card.clickable:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }

  .tenant-card.selected {
    background: #eff6ff;
    border-color: #3b82f6;
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3rem;
    height: 3rem;
    border-radius: 0.5rem;
    color: white;
    font-size: 1rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  .info {
    flex: 1;
    min-width: 0;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .name {
    font-weight: 500;
    color: #111827;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status {
    font-size: 0.625rem;
    padding: 0.125rem 0.375rem;
    border-radius: 9999px;
    text-transform: uppercase;
    font-weight: 600;
    flex-shrink: 0;
  }

  .status-active {
    background: #dcfce7;
    color: #166534;
  }

  .status-suspended {
    background: #fee2e2;
    color: #991b1b;
  }

  .status-archived {
    background: #f3f4f6;
    color: #6b7280;
  }

  .slug {
    font-size: 0.75rem;
    color: #6b7280;
    margin-top: 0.125rem;
  }

  .meta {
    margin-top: 0.25rem;
  }

  .members {
    font-size: 0.75rem;
    color: #6b7280;
  }

  .actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: none;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    cursor: pointer;
    color: #6b7280;
  }

  .action-btn:hover {
    background: #f3f4f6;
    color: #111827;
  }

  .action-btn.danger:hover {
    background: #fef2f2;
    color: #dc2626;
    border-color: #fecaca;
  }

  .action-btn svg {
    width: 1rem;
    height: 1rem;
  }
</style>
