<script lang="ts">
/**
 * MessageToolbar - Bulk action toolbar
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
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
        <Button variant="ghost" size="sm" class="link-btn" onclick={onclearselection}>
          Clear
        </Button>
      {/if}
    {:else}
      <span class="count">{totalCount} messages</span>
    {/if}
    {#if onselectall && selectedCount < totalCount}
      <Button variant="ghost" size="sm" class="link-btn" onclick={onselectall}>
        {t(M['messages.message_toolbar.select_all'])}
      </Button>
    {/if}
  </div>

  {#if selectedCount > 0 && onaction}
    <div class="actions">
      <Button variant="ghost" size="sm" class="action-btn" onclick={() => onaction?.('markRead')}>
        {t(M['messages.message_toolbar.mark_read'])}
      </Button>
      <Button variant="ghost" size="sm" class="action-btn" onclick={() => onaction?.('markUnread')}>
        {t(M['messages.message_toolbar.mark_unread'])}
      </Button>
      <Button variant="ghost" size="sm" class="action-btn" onclick={() => onaction?.('flag')}>
        Flag
      </Button>
      <Button variant="ghost" size="sm" class="action-btn" onclick={() => onaction?.('unflag')}>
        Unflag
      </Button>
      <Button variant="ghost" size="sm" class="action-btn action-btn--danger" onclick={() => onaction?.('delete')}>
        Delete
      </Button>
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

  /*
   * The link and action buttons now render through smrt-ui's <Button
   * variant="ghost">. The <button> is emitted inside the Button child, so a
   * plain scoped rule would not match — anchoring on the real `.selection-info`
   * / `.actions` elements and piercing with `:global(...)` keeps the original
   * text-link / outlined-surface styling (issue #1589). The destructive button's
   * modifier is `action-btn--danger`, NOT `danger`, so it never collides with
   * Button's own `.danger` variant class.
   */
  .selection-info :global(.link-btn) {
    border: none;
    background: none;
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-primary, #005ac1);
    text-decoration: underline;
    padding: 0;
  }

  .actions {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }

  .actions :global(.action-btn) {
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--smrt-color-outline, #72787e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }

  .actions :global(.action-btn):hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .actions :global(.action-btn--danger) {
    color: var(--smrt-color-error, #ba1a1a);
    border-color: var(--smrt-color-error, #ba1a1a);
  }
</style>
