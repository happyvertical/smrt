<script lang="ts">
/**
 * AccountCard - Individual account card with status and actions
 */
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import type { AccountData } from '../types.js';
import AccountAvatar from './AccountAvatar.svelte';

export interface Props {
  account: AccountData;
  onsync?: (account: AccountData) => void;
  onactivate?: (account: AccountData) => void;
  ondeactivate?: (account: AccountData) => void;
  onremove?: (account: AccountData) => void;
}

const { account, onsync, onactivate, ondeactivate, onremove }: Props = $props();

const _lastSyncFormatted = $derived.by(() => {
  if (!account.lastSyncAt) return 'Never synced';
  const d =
    typeof account.lastSyncAt === 'string'
      ? new Date(account.lastSyncAt)
      : account.lastSyncAt;
  return `Last sync: ${d.toLocaleString()}`;
});
</script>

<Card>
  <div class="account-card">
    <div class="account-info">
      <AccountAvatar providerType={account.providerType} name={account.name} size="lg" />
      <div class="details">
        <h3 class="name">{account.name}</h3>
        {#if account.email}
          <span class="email">{account.email}</span>
        {/if}
        <span class="provider">{account.providerType}</span>
      </div>
    </div>

    <div class="status-row">
      <span class="status" class:status--active={account.isActive} class:status--inactive={!account.isActive}>
        {account.isActive ? 'Active' : 'Inactive'}
      </span>
      <span class="sync-time">{_lastSyncFormatted}</span>
      {#if account.unreadCount !== undefined}
        <span class="unread-count">{account.unreadCount} unread</span>
      {/if}
    </div>

    <div class="actions">
      {#if onsync && account.isActive}
        <Button variant="ghost" size="sm" class="action-btn" onclick={() => onsync?.(account)}>
          Sync
        </Button>
      {/if}
      {#if account.isActive && ondeactivate}
        <Button variant="ghost" size="sm" class="action-btn" onclick={() => ondeactivate?.(account)}>
          Deactivate
        </Button>
      {/if}
      {#if !account.isActive && onactivate}
        <Button variant="ghost" size="sm" class="action-btn" onclick={() => onactivate?.(account)}>
          Activate
        </Button>
      {/if}
      {#if onremove}
        <Button variant="ghost" size="sm" class="action-btn action-btn--danger" onclick={() => onremove?.(account)}>
          Remove
        </Button>
      {/if}
    </div>
  </div>
</Card>

<style>
  .account-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .account-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .details {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .name {
    margin: 0;
    font: var(--smrt-typography-title-medium-font, 500 1rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .email {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provider {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
  }

  .status {
    padding: 0.125rem 0.375rem;
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .status--active {
    background: var(--smrt-color-tertiary-container, #d7f8d7);
    color: var(--smrt-color-on-tertiary-container, #0a3a0a);
  }

  .status--inactive {
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .sync-time {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .unread-count {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary, #005ac1);
  }

  .actions {
    display: flex;
    gap: 0.375rem;
  }

  /*
   * The action buttons now render through smrt-ui's <Button variant="ghost">.
   * Svelte scopes `.action-btn` to this component, but the <button> is emitted
   * inside the Button child, so a plain `.action-btn {}` rule would not match —
   * `.actions :global(.action-btn)` anchors on `.actions` (a real element here)
   * and pierces into the child (issue #1589). These overrides keep the original
   * outlined-surface look (border/radius/color); the modifier class is
   * `action-btn--danger`, NOT `danger`, so it never collides with Button's own
   * `.danger` variant class.
   */
  .actions :global(.action-btn) {
    padding: 0.375rem 0.75rem;
    border: 1px solid var(--smrt-color-outline, #72787e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
  }

  .actions :global(.action-btn):hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .actions :global(.action-btn--danger) {
    color: var(--smrt-color-error, #ba1a1a);
    border-color: var(--smrt-color-error, #ba1a1a);
  }
</style>
