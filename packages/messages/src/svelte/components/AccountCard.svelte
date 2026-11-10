<script lang="ts">
/**
 * AccountCard - Individual account card with status and actions
 */
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import type { AccountData } from '../types.js';
import AccountAvatar from './AccountAvatar.svelte';

export interface Props {
  /** Account data to display with its status and sync history. */
  account: AccountData;
  /** Called when user clicks the sync button to refresh the account. */
  onsync?: (account: AccountData) => void;
  /** Called when user clicks the activate button to enable the account. */
  onactivate?: (account: AccountData) => void;
  /** Called when user clicks the deactivate button to disable the account. */
  ondeactivate?: (account: AccountData) => void;
  /** Called when user clicks the remove button to delete the account. */
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
  <div class="smrt-account-card__body" data-smrt-part="body">
    <div class="smrt-account-card__header" data-smrt-part="header">
      <AccountAvatar providerType={account.providerType} name={account.name} size="lg" />
      <div class="smrt-account-card__content" data-smrt-part="body">
        <h3 class="smrt-account-card__name" data-smrt-part="title">{account.name}</h3>
        {#if account.email}
          <span class="smrt-account-card__email" data-smrt-part="meta">{account.email}</span>
        {/if}
        <span class="smrt-account-card__provider" data-smrt-part="meta">{account.providerType}</span>
      </div>
    </div>

    <div class="smrt-account-card__meta" data-smrt-part="meta">
      <span class="smrt-account-card__status" class:smrt-account-card__status--active={account.isActive} class:smrt-account-card__status--inactive={!account.isActive} data-smrt-part="badge">
        {account.isActive ? 'Active' : 'Inactive'}
      </span>
      <span class="smrt-account-card__sync-time" data-smrt-part="time">{_lastSyncFormatted}</span>
      {#if account.unreadCount !== undefined}
        <span class="smrt-account-card__unread-count" data-smrt-part="count">{account.unreadCount} unread</span>
      {/if}
    </div>

    <div class="smrt-account-card__actions" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-account-card__body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-account-card__header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .smrt-account-card__content {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }
  .smrt-account-card__name {
    margin: 0;
  }
  .smrt-account-card__email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-account-card__meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .smrt-account-card__status {
    padding: 0.125rem 0.375rem;
  }
  .smrt-account-card__actions {
    display: flex;
    gap: 0.375rem;
  }
  /*
  * The action buttons now render through smrt-ui's <Button variant="ghost">.
  * Svelte scopes `.action-btn` to this component, but the <button> is emitted
  * inside the Button child, so a plain `.action-btn {}` rule would not match —
  * `.smrt-account-card__actions :global(.action-btn)` anchors on `.smrt-account-card__actions` (a real element here)
  * and pierces into the child (issue #1589). These overrides keep the original
  * outlined-surface look (border/radius/color); the modifier class is
  * `action-btn--danger`, NOT `danger`, so it never collides with Button's own
  * `.danger` variant class.
  */
  .smrt-account-card__actions :global(.action-btn) {
    padding: 0.375rem 0.75rem;
  }
}

@layer smrt.theme {
  .smrt-account-card__name {
    font: var(--smrt-typography-title-medium-font, 500 1rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-account-card__email {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-account-card__provider {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .smrt-account-card__meta {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
  }
  .smrt-account-card__status {
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-account-card__status--active {
    background: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-account-card__status--inactive {
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-account-card__sync-time {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-account-card__unread-count {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary);
  }
  /*
  * The action buttons now render through smrt-ui's <Button variant="ghost">.
  * Svelte scopes `.action-btn` to this component, but the <button> is emitted
  * inside the Button child, so a plain `.action-btn {}` rule would not match —
  * `.smrt-account-card__actions :global(.action-btn)` anchors on `.smrt-account-card__actions` (a real element here)
  * and pierces into the child (issue #1589). These overrides keep the original
  * outlined-surface look (border/radius/color); the modifier class is
  * `action-btn--danger`, NOT `danger`, so it never collides with Button's own
  * `.danger` variant class.
  */
  .smrt-account-card__actions :global(.action-btn) {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
  }
  .smrt-account-card__actions :global(.action-btn):hover {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-account-card__actions :global(.action-btn--danger) {
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }
}

</style>
