<script lang="ts">
/**
 * AgentChat - Full agent conversation interface
 * Shows agent info header, message list with tool call displays, and input bar.
 * Agent messages are styled differently from user messages.
 */
import type {
  AgentSessionData,
  ChatMessageData,
  ToolCallDisplayData,
} from '../../types.js';
import Avatar from '../shared/Avatar.svelte';
import ToolCallDisplay from './ToolCallDisplay.svelte';

export interface Props {
  /** Agent session data */
  session: AgentSessionData;
  /** Messages in this conversation */
  messages: ChatMessageData[];
  /** Current user's profile ID */
  currentProfileId: string;
  /** Send a message to the agent */
  onsend: (content: string) => void;
  /** Close the agent chat */
  onclose?: () => void;
}

const { session, messages, currentProfileId, onsend, onclose }: Props =
  $props();

let inputValue = $state('');
let messageContainer: HTMLDivElement | undefined = $state();

const isActive = $derived(session.status === 'active');

function handleSubmit(event: Event) {
  event.preventDefault();
  const trimmed = inputValue.trim();
  if (!trimmed || !isActive) return;
  onsend(trimmed);
  inputValue = '';
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSubmit(event);
  }
}

function formatTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

$effect(() => {
  if (messages.length && messageContainer) {
    messageContainer.scrollTop = messageContainer.scrollHeight;
  }
});
</script>

<div class="agent-chat" aria-label="Agent conversation with {session.agentName}">
  <header class="agent-chat__header">
    <div class="agent-chat__agent-info">
      <Avatar
        name={session.agentName}
        avatarUrl={session.agentAvatarUrl}
        size="md"
      />
      <div class="agent-chat__agent-meta">
        <span class="agent-chat__agent-name">{session.agentName}</span>
        <span class="agent-chat__status" class:agent-chat__status--active={isActive}>
          {session.status === 'active' ? 'Active' : session.status === 'closed' ? 'Closed' : 'Expired'}
        </span>
      </div>
    </div>

    <div class="agent-chat__header-actions">
      {#if session.allowedTools.length > 0}
        <span class="agent-chat__tool-count" title="Allowed tools: {session.allowedTools.join(', ')}">
          {session.allowedTools.length} tool{session.allowedTools.length !== 1 ? 's' : ''}
        </span>
      {/if}

      {#if onclose}
        <button
          class="agent-chat__close-btn"
          type="button"
          onclick={onclose}
          aria-label="Close agent chat"
          title="Close"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      {/if}
    </div>
  </header>

  <div
    class="agent-chat__messages"
    bind:this={messageContainer}
    role="log"
    aria-label="Agent conversation messages"
  >
    {#each messages as msg (msg.id)}
      {@const isUser = msg.role === 'user'}
      {@const isToolCall = msg.messageType === 'tool_call' || msg.messageType === 'tool_result'}

      {#if isToolCall && msg.toolCallData}
        <div class="agent-chat__tool-row">
          <ToolCallDisplay toolCall={msg.toolCallData} />
        </div>
      {:else}
        <div
          class="agent-chat__msg"
          class:agent-chat__msg--user={isUser}
          class:agent-chat__msg--agent={!isUser && !isToolCall}
          class:agent-chat__msg--system={msg.role === 'system'}
        >
          {#if !isUser}
            <Avatar
              name={msg.senderName}
              avatarUrl={msg.senderAvatarUrl}
              size="sm"
            />
          {/if}

          <div class="agent-chat__bubble" class:agent-chat__bubble--user={isUser} class:agent-chat__bubble--agent={!isUser}>
            {#if !isUser}
              <span class="agent-chat__msg-sender">{msg.senderName}</span>
            {/if}
            <div class="agent-chat__msg-content">{msg.content}</div>
            <time class="agent-chat__msg-time">{formatTime(msg.createdAt)}</time>
          </div>
        </div>
      {/if}
    {/each}

    {#if messages.length === 0}
      <div class="agent-chat__empty">
        <span class="agent-chat__empty-text">Start a conversation with {session.agentName}</span>
      </div>
    {/if}
  </div>

  <form class="agent-chat__input-bar" onsubmit={handleSubmit}>
    {#if !isActive}
      <div class="agent-chat__inactive-notice">
        This session is {session.status}. You cannot send new messages.
      </div>
    {:else}
      <textarea
        class="agent-chat__input"
        placeholder="Message {session.agentName}..."
        bind:value={inputValue}
        onkeydown={handleKeydown}
        rows={1}
        disabled={!isActive}
        aria-label="Message input"
      ></textarea>
      <button
        class="agent-chat__send-btn"
        type="submit"
        disabled={!inputValue.trim() || !isActive}
        aria-label="Send message"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </button>
    {/if}
  </form>
</div>

<style>
  .agent-chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .agent-chat__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--smrt-color-surface-container, #f0f0f4);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    flex-shrink: 0;
  }

  .agent-chat__agent-info {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .agent-chat__agent-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .agent-chat__agent-name {
    font: var(--smrt-typography-title-small-font, 600 0.875rem/1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agent-chat__status {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  .agent-chat__status--active {
    color: #4caf50;
  }

  .agent-chat__header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .agent-chat__tool-count {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface-variant, #e1e2ec);
    padding: 4px 8px;
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: default;
  }

  .agent-chat__close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    background: none;
    color: var(--smrt-color-on-surface-variant, #43474e);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .agent-chat__close-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .agent-chat__close-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .agent-chat__messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-behavior: smooth;
  }

  .agent-chat__msg {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    max-width: 80%;
  }

  .agent-chat__msg--user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .agent-chat__msg--system {
    align-self: center;
    max-width: 90%;
  }

  .agent-chat__tool-row {
    width: 100%;
    padding: 4px 0;
  }

  .agent-chat__bubble {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
    border-radius: var(--smrt-radius-large, 12px);
    word-break: break-word;
  }

  .agent-chat__bubble--user {
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    border-bottom-right-radius: var(--smrt-radius-small, 4px);
  }

  .agent-chat__bubble--agent {
    background: var(--smrt-color-surface-container-high, #e6e6ea);
    color: var(--smrt-color-on-surface, #1a1c1e);
    border-bottom-left-radius: var(--smrt-radius-small, 4px);
  }

  .agent-chat__msg--system .agent-chat__bubble {
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-style: italic;
    text-align: center;
  }

  .agent-chat__msg-sender {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--smrt-color-primary, #005ac1);
    line-height: 1;
  }

  .agent-chat__msg-content {
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    white-space: pre-wrap;
  }

  .agent-chat__msg-time {
    font-size: 0.625rem;
    color: var(--smrt-color-outline, #74777f);
    align-self: flex-end;
    line-height: 1;
  }

  .agent-chat__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 120px;
  }

  .agent-chat__empty-text {
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  .agent-chat__input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    background: var(--smrt-color-surface, #fefbff);
    flex-shrink: 0;
  }

  .agent-chat__inactive-notice {
    flex: 1;
    text-align: center;
    padding: 8px;
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-outline, #74777f);
    font-style: italic;
  }

  .agent-chat__input {
    flex: 1;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-large, 12px);
    padding: 10px 14px;
    font: var(--smrt-typography-body-medium-font, 0.875rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    resize: none;
    outline: none;
    min-height: 40px;
    max-height: 120px;
  }

  .agent-chat__input:focus {
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 1px var(--smrt-color-primary, #005ac1);
  }

  .agent-chat__input::placeholder {
    color: var(--smrt-color-outline, #74777f);
  }

  .agent-chat__send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border: none;
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity var(--smrt-duration-short2, 150ms);
  }

  .agent-chat__send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .agent-chat__send-btn:not(:disabled):hover {
    opacity: 0.85;
  }

  .agent-chat__send-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .agent-chat__messages {
      scroll-behavior: auto;
    }

    .agent-chat__close-btn,
    .agent-chat__send-btn {
      transition: none;
    }
  }
</style>
