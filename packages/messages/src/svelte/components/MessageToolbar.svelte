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
  /** Number of messages currently selected. */
  selectedCount: number;
  /** Total number of messages in the list. */
  totalCount: number;
  /** Called when user performs a bulk action. */
  onaction?: (action: BulkAction) => void;
  /** Called when user clicks select all. */
  onselectall?: () => void;
  /** Called when user clears the selection. */
  onclearselection?: () => void;
  /** Snippet for rendering additional action buttons. */
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

<div class="smrt-message-toolbar__root" role="toolbar" aria-label={t(M['messages.message_toolbar.actions_label'])} data-smrt-component="MessageToolbar">
  <div class="smrt-message-toolbar__selection" data-smrt-part="control">
    {#if selectedCount > 0}
      <span class="smrt-message-toolbar__count" data-smrt-part="count">{t(M['messages.message_toolbar.count_selected'], { selectedCount, totalCount })}</span>
      {#if onclearselection}
        <Button variant="ghost" size="sm" class="link-btn" onclick={onclearselection}>
          Clear
        </Button>
      {/if}
    {:else}
      <span class="smrt-message-toolbar__count" data-smrt-part="count">{totalCount} messages</span>
    {/if}
    {#if onselectall && selectedCount < totalCount}
      <Button variant="ghost" size="sm" class="link-btn" onclick={onselectall}>
        {t(M['messages.message_toolbar.select_all'])}
      </Button>
    {/if}
  </div>

  {#if selectedCount > 0 && onaction}
    <div class="smrt-message-toolbar__actions" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-toolbar__root {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .smrt-message-toolbar__selection {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  /*
  * The link and action buttons now render through smrt-ui's <Button
  * variant="ghost">. The <button> is emitted inside the Button child, so a
  * plain scoped rule would not match — anchoring on the real `.smrt-message-toolbar__selection`
  * / `.smrt-message-toolbar__actions` elements and piercing with `:global(...)` keeps the original
  * text-link / outlined-surface styling (issue #1589). The destructive button's
  * modifier is `action-btn--danger`, NOT `danger`, so it never collides with
  * Button's own `.danger` variant class.
  */
  .smrt-message-toolbar__selection :global(.link-btn) {
    padding: 0;
  }
  .smrt-message-toolbar__actions {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }
  .smrt-message-toolbar__actions :global(.action-btn) {
    padding: 0.25rem 0.625rem;
  }
}

@layer smrt.theme {
  .smrt-message-toolbar__root {
    background: var(--smrt-color-surface-variant);
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
  .smrt-message-toolbar__count {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  /*
  * The link and action buttons now render through smrt-ui's <Button
  * variant="ghost">. The <button> is emitted inside the Button child, so a
  * plain scoped rule would not match — anchoring on the real `.smrt-message-toolbar__selection`
  * / `.smrt-message-toolbar__actions` elements and piercing with `:global(...)` keeps the original
  * text-link / outlined-surface styling (issue #1589). The destructive button's
  * modifier is `action-btn--danger`, NOT `danger`, so it never collides with
  * Button's own `.danger` variant class.
  */
  .smrt-message-toolbar__selection :global(.link-btn) {
    border: none;
    background: none;
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }
  .smrt-message-toolbar__actions :global(.action-btn) {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }
  .smrt-message-toolbar__actions :global(.action-btn):hover {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-message-toolbar__actions :global(.action-btn--danger) {
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }
}

</style>
