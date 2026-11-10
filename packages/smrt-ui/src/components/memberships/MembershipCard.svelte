<script lang="ts">
import type { Membership, Role, Tenant } from '@happyvertical/smrt-types';
import { M, useI18n } from '@happyvertical/smrt-ui/i18n';
import RoleBadge from '../roles/RoleBadge.svelte';

const { t } = useI18n();

interface Props {
  /** The membership record to display. */
  membership: Membership;
  /** The tenant associated with this membership. */
  tenant: Tenant;
  /** The role assigned in this membership. */
  role: Role;
  /** Fired when the remove button is clicked. */
  onremove?: () => void;
  /** Fired when the change role button is clicked. */
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

<div class="smrt-membership-card__root" data-smrt-component="MembershipCard">
  <div class="smrt-membership-card__main" data-smrt-part="header">
    <div class="smrt-membership-card__tenant-info" data-smrt-part="row">
      <span class="smrt-membership-card__tenant-name" data-smrt-part="title">{tenant.name}</span>
      <span class="smrt-membership-card__status smrt-membership-card__{getStatusColor(membership.status)}" data-smrt-part="status">{membership.status}</span>
    </div>

    <div class="smrt-membership-card__role-info" data-smrt-part="role">
      <RoleBadge {role} />
    </div>
  </div>

  <div class="smrt-membership-card__meta" data-smrt-part="meta">
    <span class="smrt-membership-card__date" data-smrt-part="time">Joined {formatDate(membership.created_at)}</span>

    {#if onchangerole || onremove}
      <div class="smrt-membership-card__actions" data-smrt-part="actions">
        {#if onchangerole}
          <button type="button" class="smrt-membership-card__action-btn" data-smrt-part="action" onclick={onchangerole}>{t(M['ui.membership_card.change_role'])}</button>
        {/if}
        {#if onremove}
          <button type="button" class="smrt-membership-card__action-btn smrt-membership-card__danger" data-smrt-part="action" onclick={onremove}>Remove</button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-membership-card__root {
    padding: 1rem;
  }
  .smrt-membership-card__main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .smrt-membership-card__tenant-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-membership-card__status {
    padding: 0.125rem 0.375rem;
  }
  .smrt-membership-card__role-info {
    flex-shrink: 0;
  }
  .smrt-membership-card__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
  }
  .smrt-membership-card__actions {
    display: flex;
    gap: 0.5rem;
  }
  .smrt-membership-card__action-btn {
    padding: 0.25rem 0.5rem;
    cursor: pointer;
  }
}

@layer smrt.theme {
  .smrt-membership-card__root {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.5rem;
  }
  .smrt-membership-card__tenant-name {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-membership-card__status {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    border-radius: var(--smrt-radius-full);
    text-transform: uppercase;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-membership-card__status-active {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-membership-card__status-pending {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-membership-card__status-suspended {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-membership-card__meta {
    border-top: var(--smrt-hairline);
  }
  .smrt-membership-card__date {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-membership-card__action-btn {
    background: none;
    border: var(--smrt-hairline-strong);
    border-radius: 0.25rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-membership-card__action-btn:hover {
    background: var(--smrt-color-surface-container);
  }
  .smrt-membership-card__action-btn.smrt-membership-card__danger {
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }
  .smrt-membership-card__action-btn.smrt-membership-card__danger:hover {
    background: var(--smrt-color-error-container);
  }
}

</style>
