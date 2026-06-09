<script lang="ts">
/**
 * MessageItem - Individual message row
 * Displays avatar, message bubble, reactions, reply preview, and tool call data.
 */

import type { ChatMessageData } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';
import MessageBubble from '../shared/MessageBubble.svelte';
import ReactionPicker from '../shared/ReactionPicker.svelte';

export interface Props {
  /** Message data to render */
  message: ChatMessageData;
  /** Whether this message was sent by the current user */
  isOwn: boolean;
  /** Reply callback */
  onreply?: (id: string) => void;
  /** React callback */
  onreact?: (id: string, emoji: string) => void;
  /** Edit callback */
  onedit?: (id: string) => void;
  /** Delete callback */
  ondelete?: (id: string) => void;
}

const { message, isOwn, onreply, onreact, onedit, ondelete }: Props = $props();

let showReactionPicker = $state(false);
let showActions = $state(false);

const bubbleVariant = $derived.by(() => {
  if (message.messageType === 'system' || message.messageType === 'action')
    return 'system';
  if (
    message.role === 'assistant' ||
    message.messageType === 'tool_call' ||
    message.messageType === 'tool_result'
  )
    return 'agent';
  return 'default';
});

const formattedTime = $derived.by(() => {
  const d =
    message.createdAt instanceof Date
      ? message.createdAt
      : new Date(message.createdAt);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
});

function handleReact(emoji: string) {
  onreact?.(message.id, emoji);
  showReactionPicker = false;
}

function toggleReactionPicker() {
  showReactionPicker = !showReactionPicker;
}
</script>

{#if message.messageType === 'system' || message.messageType === 'action'}
  <div class="message-item message-item--system">
    <MessageBubble content={message.content} isOwn={false} variant="system" />
  </div>
{:else}
  <div
    class="message-item"
    class:message-item--own={isOwn}
    role="article"
    aria-label="Message from {message.senderName}"
    onmouseenter={() => showActions = true}
    onmouseleave={() => { showActions = false; showReactionPicker = false; }}
  >
    {#if !isOwn}
      <div class="message-item__avatar">
        <Avatar
          name={message.senderName}
          avatarUrl={message.senderAvatarUrl}
          size="sm"
        />
      </div>
    {/if}

    <div class="message-item__body">
      {#if !isOwn}
        <span class="message-item__sender">{message.senderName}</span>
      {/if}

      {#if message.replyTo}
        <div class="message-item__reply-preview">
          <span class="message-item__reply-name">{message.replyTo.senderName}</span>
          <span class="message-item__reply-text">{message.replyTo.content}</span>
        </div>
      {/if}

      <MessageBubble
        content={message.content}
        {isOwn}
        variant={bubbleVariant}
      />

      {#if message.toolCallData}
        <div class="message-item__tool-call">
          <span class="message-item__tool-name">
            {message.toolCallData.toolName}
          </span>
          <span class="message-item__tool-status {message.toolCallData.status}">
            {message.toolCallData.status}
          </span>
          {#if message.toolCallData.duration}
            <span class="message-item__tool-duration">
              {message.toolCallData.duration}ms
            </span>
          {/if}
          {#if message.toolCallData.error}
            <span class="message-item__tool-error">{message.toolCallData.error}</span>
          {/if}
        </div>
      {/if}

      {#if message.reactions.length > 0}
        <div class="message-item__reactions">
          {#each message.reactions as reaction}
            <button
              class="message-item__reaction"
              class:message-item__reaction--active={reaction.reacted}
              type="button"
              onclick={() => onreact?.(message.id, reaction.emoji)}
              aria-label="{reaction.emoji} {reaction.count}"
            >
              <span class="message-item__reaction-emoji">{reaction.emoji}</span>
              <span class="message-item__reaction-count">{reaction.count}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="message-item__meta">
        <span class="message-item__time">{formattedTime}</span>
        {#if message.isEdited}
          <span class="message-item__edited">(edited)</span>
        {/if}
      </div>
    </div>

    {#if showActions}
      <div class="message-item__actions">
        {#if onreact}
          <button
            class="message-item__action-btn"
            type="button"
            onclick={toggleReactionPicker}
            aria-label="Add reaction"
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.2" /><circle cx="5.5" cy="6.5" r="0.8" fill="currentColor" /><circle cx="10.5" cy="6.5" r="0.8" fill="currentColor" /><path d="M5.5 9.5c.5 1.2 1.5 1.8 2.5 1.8s2-.6 2.5-1.8" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" /></svg>
          </button>
        {/if}
        {#if onreply}
          <button
            class="message-item__action-btn"
            type="button"
            onclick={() => onreply?.(message.id)}
            aria-label="Reply"
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 3L2 7l4 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /><path d="M2 7h8c2.2 0 4 1.8 4 4v1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        {/if}
        {#if isOwn && onedit}
          <button
            class="message-item__action-btn"
            type="button"
            onclick={() => onedit?.(message.id)}
            aria-label="Edit"
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M11.5 1.5l3 3L5 14H2v-3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        {/if}
        {#if isOwn && ondelete}
          <button
            class="message-item__action-btn"
            type="button"
            onclick={() => ondelete?.(message.id)}
            aria-label="Delete"
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 4h12M5.3 4V2.7A.7.7 0 016 2h4a.7.7 0 01.7.7V4m1.6 0v9.3a1.4 1.4 0 01-1.4 1.4H5.1a1.4 1.4 0 01-1.4-1.4V4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        {/if}
      </div>

      {#if showReactionPicker}
        <div class="message-item__picker-popover">
          <ReactionPicker isOpen={true} onreact={handleReact} />
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .message-item {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
    position: relative;
  }

  .message-item--own {
    flex-direction: row-reverse;
  }

  .message-item--system {
    justify-content: center;
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
  }

  .message-item__avatar {
    flex-shrink: 0;
    margin-top: var(--smrt-spacing-1, 0.25rem);
  }

  .message-item__body {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
    min-width: 0;
    max-width: 75%;
  }

  .message-item--own .message-item__body {
    align-items: flex-end;
  }

  .message-item__sender {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: 500;
    color: var(--smrt-color-on-surface-variant, #43474e);
    padding-left: var(--smrt-spacing-1, 0.25rem);
  }

  .message-item__reply-preview {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-3, 0.75rem);
    border-left: 2px solid var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    max-width: 100%;
    overflow: hidden;
  }

  .message-item__reply-name {
    font-weight: 500;
    color: var(--smrt-color-primary, #005ac1);
  }

  .message-item__reply-text {
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .message-item__tool-call {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
  }

  .message-item__tool-name {
    font-weight: 500;
    color: var(--smrt-color-on-surface, #1b1b1f);
  }

  .message-item__tool-status {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: 0.625rem;
    text-transform: uppercase;
    font-weight: 600;
  }

  .message-item__tool-status.pending {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .message-item__tool-status.running {
    background: var(--smrt-color-primary-container, #e3f2fd);
    color: var(--smrt-color-on-primary-container, #1565c0);
  }

  .message-item__tool-status.success {
    background: var(--smrt-color-success-container, #e8f5e9);
    color: var(--smrt-color-on-success-container, #2e7d32);
  }

  .message-item__tool-status.error {
    background: var(--smrt-color-error-container, #ffebee);
    color: var(--smrt-color-on-error-container, #c62828);
  }

  .message-item__tool-duration {
    color: var(--smrt-color-outline, #74777f);
  }

  .message-item__tool-error {
    color: var(--smrt-color-on-error-container, #c62828);
  }

  .message-item__reactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .message-item__reaction {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface, #ffffff);
    cursor: pointer;
    font-size: 0.75rem;
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .message-item__reaction:hover {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
  }

  .message-item__reaction--active {
    border-color: var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary-container, #d6e3ff);
  }

  .message-item__reaction-emoji {
    font-size: 0.8125rem;
    line-height: 1;
  }

  .message-item__reaction-count {
    font-size: 0.6875rem;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .message-item__meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding-left: var(--smrt-spacing-1, 0.25rem);
  }

  .message-item__time {
    font-size: 0.625rem;
    color: var(--smrt-color-outline, #74777f);
  }

  .message-item__edited {
    font-size: 0.625rem;
    color: var(--smrt-color-outline, #74777f);
    font-style: italic;
  }

  .message-item__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    position: absolute;
    top: 0;
    right: var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-surface, #ffffff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-small, 0.25rem);
    padding: var(--smrt-spacing-1, 4px);
    box-shadow: var(--smrt-elevation-level1, 0 1px 3px rgba(0, 0, 0, 0.12));
  }

  .message-item--own .message-item__actions {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }

  .message-item__action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .message-item__action-btn:hover {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
  }

  .message-item__picker-popover {
    position: absolute;
    top: -8px;
    right: var(--smrt-spacing-4, 1rem);
    z-index: 10;
    transform: translateY(-100%);
  }

  .message-item--own .message-item__picker-popover {
    right: auto;
    left: var(--smrt-spacing-4, 1rem);
  }
</style>
