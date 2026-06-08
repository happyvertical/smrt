<script lang="ts">
/**
 * ThreadPanel - Side panel for threaded conversation
 * Shows the root message, thread replies, and an input for new replies.
 */

import type { ChatMessageData, ChatThreadData } from '../../types.js';
import MessageInput from './MessageInput.svelte';
import MessageList from './MessageList.svelte';

export interface Props {
  /** Thread metadata */
  thread: ChatThreadData;
  /** Messages in the thread */
  messages: ChatMessageData[];
  /** Current user's profile ID */
  currentProfileId: string;
  /** Send a reply to the thread */
  onsend: (content: string) => void;
  /** Close the thread panel */
  onclose: () => void;
}

const { thread, messages, currentProfileId, onsend, onclose }: Props = $props();

const threadTitle = $derived(thread.title || 'Thread');
const replyCount = $derived(
  thread.messageCount > 0 ? thread.messageCount - 1 : 0,
);
</script>

<aside class="thread-panel" aria-label="Thread: {threadTitle}">
  <header class="thread-panel__header">
    <div class="thread-panel__header-text">
      <h3 class="thread-panel__title">{threadTitle}</h3>
      <span class="thread-panel__meta">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        {#if thread.participantCount > 0}
          &middot; {thread.participantCount} {thread.participantCount === 1 ? 'participant' : 'participants'}
        {/if}
      </span>
    </div>
    {#if thread.isResolved}
      <span class="thread-panel__resolved">Resolved</span>
    {/if}
    <button
      class="thread-panel__close"
      type="button"
      onclick={onclose}
      aria-label="Close thread"
    >
      <svg viewBox="0 0 16 16" width="16" height="16">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>
  </header>

  <div class="thread-panel__messages">
    <MessageList
      {messages}
      {currentProfileId}
    />
  </div>

  <div class="thread-panel__input">
    <MessageInput
      {onsend}
      placeholder="Reply in thread..."
    />
  </div>
</aside>

<style>
  .thread-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    background: var(--smrt-color-surface, #ffffff);
    border-left: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .thread-panel__header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-4, 1rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    flex-shrink: 0;
  }

  .thread-panel__header-text {
    flex: 1;
    min-width: 0;
  }

  .thread-panel__title {
    margin: 0;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: 600;
    color: var(--smrt-color-on-surface, #1b1b1f);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .thread-panel__meta {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .thread-panel__resolved {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: 500;
    color: var(--smrt-color-on-success-container, #2e7d32);
    background: var(--smrt-color-success-container, #e8f5e9);
    border-radius: var(--smrt-radius-full, 9999px);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .thread-panel__close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .thread-panel__close:hover {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
  }

  .thread-panel__messages {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .thread-panel__input {
    flex-shrink: 0;
  }
</style>
