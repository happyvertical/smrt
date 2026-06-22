<script lang="ts">
/**
 * TenantCard - Tenant information and management
 * refactored for Material 3
 */

import { Icon, ripple } from '@happyvertical/smrt-svelte';
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import type { Tenant } from '@happyvertical/smrt-types';
import { M } from '../i18n.js';

export interface Props {
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

const { t } = useI18n();

const statusClass = $derived.by(() => {
  switch (tenant.status) {
    case 'active':
      return 'status-active';
    case 'suspended':
      return 'status-error';
    case 'archived':
      return 'status-disabled';
    default:
      return '';
  }
});

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

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="tenant-card"
  class:clickable={!!onclick}
  class:selected
  role={onclick ? 'button' : undefined}
  tabindex={onclick ? 0 : undefined}
  onclick={onclick}
  onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && onclick?.()}
  use:ripple
>
  <div class="avatar" style:background-color={getColor(tenant.name ?? '')}>
    {getInitials(tenant.name ?? 'T')}
  </div>

  <div class="info">
    <div class="header">
      <span class="name">{tenant.name}</span>
      <span class="status {statusClass}">{tenant.status}</span>
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
        <button 
          type="button" 
          class="action-btn" 
          onclick={(event: MouseEvent) => { event.stopPropagation(); onedit?.(); }}
          use:ripple
          aria-label={t(M['tenancy.tenant_card.edit'])}
        >
          <Icon name="menu" size={18} />
        </button>
      {/if}
      {#if ondelete}
        <button 
          type="button" 
          class="action-btn danger" 
          onclick={(event: MouseEvent) => { event.stopPropagation(); ondelete?.(); }}
          use:ripple
          aria-label={t(M['tenancy.tenant_card.delete'])}
        >
          <Icon name="close" size={18} />
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tenant-card {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4, 16px);
    padding: var(--smrt-spacing-4, 16px);
    background-color: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-lg, 12px);
    color: var(--smrt-color-on-surface);
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    position: relative;
    overflow: hidden;
    box-shadow: var(--smrt-elevation-1);
  }

  .tenant-card.clickable {
    cursor: pointer;
  }

  .tenant-card.clickable:hover {
    background-color: var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-2);
  }

  .tenant-card.selected {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    border-radius: var(--smrt-radius-lg, 12px);
    color: white;
    font: var(--smrt-typography-title-medium-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    flex-shrink: 0;
  }

  .info {
    flex: 1;
    min-width: 0;
  }

  .header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
  }

  .name {
    font: var(--smrt-typography-title-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status {
    font: var(--smrt-typography-label-small-font);
    padding: 0 var(--smrt-spacing-2, 8px);
    height: 18px;
    display: inline-flex;
    align-items: center;
    border-radius: var(--smrt-radius-md, 8px);
    text-transform: uppercase;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    flex-shrink: 0;
  }

  .status-active {
    background-color: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .status-error {
    background-color: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .status-disabled {
    background-color: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }

  .slug {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .selected .slug {
    color: var(--smrt-color-on-secondary-container);
    opacity: 0.8;
  }

  .meta {
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .members {
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-1, 4px);
    flex-shrink: 0;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: transparent;
    border: none;
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    color: var(--smrt-color-on-surface-variant);
    position: relative;
    overflow: hidden;
  }

  .action-btn:hover {
    background-color: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface);
  }

  .action-btn.danger:hover {
    color: var(--smrt-color-error);
  }
</style>
