<script lang="ts">
/**
 * MessageList - Scrollable message feed
 * Renders MessageItem for each message, grouped by date.
 * Supports infinite scroll via onloadmore callback.
 */

import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { M } from '../../i18n.messages.js';
import type { ChatMessageData } from '../../types.js';
import MessageItem from './MessageItem.svelte';

const { t } = useI18n();

export interface Props {
  /** Messages to display */
  messages: ChatMessageData[];
  /** Current user's profile ID to determine own messages */
  currentProfileId: string;
  /** Load more messages (infinite scroll) */
  onloadmore?: () => void;
  /** Reply to a message */
  onreply?: (id: string) => void;
  /** React to a message */
  onreact?: (id: string, emoji: string) => void;
}

const { messages, currentProfileId, onloadmore, onreply, onreact }: Props =
  $props();

let scrollContainer: HTMLDivElement | undefined = $state();

/** Group messages by date for date separator headers */
const groupedMessages = $derived.by(() => {
  const groups: Array<{ dateLabel: string; messages: ChatMessageData[] }> = [];
  let currentDate = '';

  for (const msg of messages) {
    const d =
      msg.createdAt instanceof Date ? msg.createdAt : new Date(msg.createdAt);
    const dateStr = d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    if (dateStr !== currentDate) {
      currentDate = dateStr;
      groups.push({ dateLabel: dateStr, messages: [] });
    }
    groups[groups.length - 1].messages.push(msg);
  }

  return groups;
});

function handleScroll(event: Event) {
  if (!onloadmore) return;
  const target = event.target as HTMLElement;
  if (target.scrollTop < 60) {
    onloadmore();
  }
}
</script>

<div
  class="message-list"
  bind:this={scrollContainer}
  onscroll={handleScroll}
  role="log"
  aria-label={t(M['chat.message_list.messages_label'])}
>
  {#if messages.length === 0}
    <div class="message-list__empty">
      <span>{t(M['chat.message_list.no_messages'])}</span>
    </div>
  {:else}
    {#each groupedMessages as group}
      <div class="message-list__date-separator" role="separator">
        <span class="message-list__date-label">{group.dateLabel}</span>
      </div>
      {#each group.messages as message (message.id)}
        <MessageItem
          {message}
          isOwn={message.senderProfileId === currentProfileId}
          {onreply}
          {onreact}
        />
      {/each}
    {/each}
  {/if}
</div>

<style>
  .message-list {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.375rem);
    overflow-y: auto;
    flex: 1;
    padding: var(--smrt-spacing-4, 1rem) 0;
    min-height: 0;
  }

  .message-list__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .message-list__date-separator {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
  }

  .message-list__date-label {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-3, 0.75rem);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-full, 9999px);
    white-space: nowrap;
  }
</style>
