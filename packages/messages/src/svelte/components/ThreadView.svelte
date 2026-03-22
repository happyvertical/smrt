<script lang="ts">
/**
 * ThreadView - Conversation thread with collapsible messages
 */
import type { MessageData } from '../types.js';
import MessageDetail from './MessageDetail.svelte';

export interface Props {
  messages: MessageData[];
  activeMessageId?: string;
  initialCollapsed?: Set<string>;
  onmessageclick?: (message: MessageData) => void;
  onreply?: (message: MessageData) => void;
}

const {
  messages,
  activeMessageId,
  initialCollapsed,
  onmessageclick,
  onreply,
}: Props = $props();

let collapsed: Set<string> = $state(new Set<string>());

$effect(() => {
  collapsed = new Set(initialCollapsed ?? []);
});

function activateMessage(message: MessageData) {
  onmessageclick?.(message);
}

function handleMessageKeydown(event: KeyboardEvent, message: MessageData) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    activateMessage(message);
  }
}

function toggleCollapse(messageId: string) {
  if (collapsed.has(messageId)) {
    collapsed.delete(messageId);
  } else {
    collapsed.add(messageId);
  }
  collapsed = new Set(collapsed);
}

const _sortedMessages = $derived(
  [...messages].sort((a, b) => {
    const dateA =
      typeof a.date === 'string'
        ? new Date(a.date).getTime()
        : a.date?.getTime() || 0;
    const dateB =
      typeof b.date === 'string'
        ? new Date(b.date).getTime()
        : b.date?.getTime() || 0;
    return dateA - dateB;
  }),
);
</script>

<div class="thread-view" role="list" aria-label="Conversation thread">
  {#each _sortedMessages as message, i (message.id)}
    <div
      class="thread-message"
      class:thread-message--active={message.id === activeMessageId}
      class:thread-message--collapsed={collapsed.has(message.id)}
      role="listitem"
    >
      {#if collapsed.has(message.id)}
        <button
          class="collapsed-header"
          type="button"
          onclick={() => toggleCollapse(message.id)}
        >
          <span class="collapsed-sender">
            {message.senderName || message.senderAddress}
          </span>
          <span class="collapsed-preview">
            {message.body?.slice(0, 80) || '(no content)'}...
          </span>
          <span class="collapsed-date">
            {typeof message.date === 'string'
              ? new Date(message.date).toLocaleDateString()
              : message.date?.toLocaleDateString() || ''}
          </span>
        </button>
      {:else}
        <div class="message-wrapper">
          {#if messages.length > 1}
            <button
              class="collapse-btn"
              type="button"
              onclick={() => toggleCollapse(message.id)}
              title="Collapse"
              aria-label="Collapse message"
            >
              ▼
            </button>
          {/if}
          {#if onmessageclick}
            <div
              role="button"
              tabindex="0"
              onclick={() => activateMessage(message)}
              onkeydown={(event) => handleMessageKeydown(event, message)}
            >
              <MessageDetail
                {message}
                onreply={onreply}
              />
            </div>
          {:else}
            <div>
              <MessageDetail
                {message}
                onreply={onreply}
              />
            </div>
          {/if}
        </div>
      {/if}

      {#if i < _sortedMessages.length - 1}
        <div class="thread-connector"></div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .thread-view {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .thread-message {
    position: relative;
  }

  .thread-message--active {
    box-shadow: -3px 0 0 0 var(--smrt-color-primary, #005ac1);
  }

  .thread-connector {
    width: 2px;
    height: 1rem;
    background: var(--smrt-color-outline-variant, #c4c6d0);
    margin-left: 1.5rem;
  }

  .message-wrapper {
    position: relative;
  }

  .collapse-btn {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, #43474e);
    z-index: 1;
    padding: 0.25rem;
    border-radius: var(--smrt-radius-small, 0.25rem);
  }

  .collapse-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .collapsed-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: var(--smrt-color-surface-variant, #e1e2ec);
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .collapsed-header:hover {
    background: var(--smrt-color-surface-variant-hover, #d1d3dd);
  }

  .collapsed-sender {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    font-weight: 500;
    flex-shrink: 0;
  }

  .collapsed-preview {
    flex: 1;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collapsed-date {
    flex-shrink: 0;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }
</style>
