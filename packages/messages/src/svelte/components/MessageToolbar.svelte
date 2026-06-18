<script lang="ts">
/**
 * MessageToolbar - Bulk action toolbar
 */
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import type { Snippet } from 'svelte';
import { M } from '../i18n.messages.js';
import type { BulkAction } from '../types.js';

const { t } = useI18n();

export interface Props {
  selectedCount: number;
  totalCount: number;
  onaction?: (action: BulkAction) => void;
  onselectall?: () => void;
  onclearselection?: () => void;
  extraActions?: Snippet;
}

const {
  selectedCount,
  totalCount,
  onaction,
  onselectall,
  onclearselection,
  extraActions,
}: Props = $props();
</script>

<div class="toolbar" role="toolbar" aria-label={t(M['messages.message_toolbar.actions_label'])}>
  <div class="selection-info">
    {#if selectedCount > 0}
      <span class="count">{t(M['messages.message_toolbar.count_selected'], { selectedCount, totalCount })}</span>
      {#if onclearselection}
        <button class="link-btn" type="button" onclick={onclearselection}>
          Clear
        </button>
      {/if}
    {:else}
      <span class="count">{totalCount} messages</span>
    {/if}
    {#if onselectall && selectedCount < totalCount}
      <button class="link-btn" type="button" onclick={onselectall}>
        {t(M['messages.message_toolbar.select_all'])}
      </button>
    {/if}
  </div>

  {#if selectedCount > 0 && onaction}
    <div class="actions">
      <button class="action-btn" type="button" onclick={() => onaction?.('markRead')}>
        {t(M['messages.message_toolbar.mark_read'])}
      </button>
      <button class="action-btn" type="button" onclick={() => onaction?.('markUnread')}>
        {t(M['messages.message_toolbar.mark_unread'])}
      </button>
      <button class="action-btn" type="button" onclick={() => onaction?.('flag')}>
        Flag
      </button>
      <button class="action-btn" type="button" onclick={() => onaction?.('unflag')}>
        Unflag
      </button>
      <button class="action-btn action-btn--danger" type="button" onclick={() => onaction?.('delete')}>
        Delete
      </button>
      {#if extraActions}
        {@render extraActions()}
      {/if}
    </div>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    background: var(--smrt-color-surface-variant, #e1e2ec);
    border-radius: var(--smrt-radius-small, 0.25rem);
    gap: 1rem;
    flex-wrap: wrap;
  }

  .selection-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .count {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .link-btn {
    border: none;
    background: none;
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-primary, #005ac1);
    cursor: pointer;
    text-decoration: underline;
    padding: 0;
  }

  .actions {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .action-btn {
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--smrt-color-outline, #72787e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    cursor: pointer;
  }

  .action-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .action-btn--danger {
    color: var(--smrt-color-error, #ba1a1a);
    border-color: var(--smrt-color-error, #ba1a1a);
  }
</style>
