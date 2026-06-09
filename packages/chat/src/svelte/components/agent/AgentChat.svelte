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
import { parseAgentMessageBlocks } from './message-blocks.js';
import ToolCallDisplay from './ToolCallDisplay.svelte';

export interface Props {
  /** Agent session data */
  session: AgentSessionData;
  /** Messages in this conversation */
  messages: ChatMessageData[];
  /** Current user's profile ID */
  currentProfileId: string;
  /** Whether the AI is currently processing */
  loading?: boolean;
  /** Send a message to the agent */
  onsend: (content: string) => void;
  /** Apply suggested markdown edit to host */
  onapplychange?: (content: string) => void;
  /** Close the agent chat */
  onclose?: () => void;
}

const {
  session,
  messages,
  currentProfileId,
  loading = false,
  onsend,
  onapplychange,
  onclose,
}: Props = $props();

let inputValue = $state('');
let messageContainer: HTMLDivElement | undefined = $state();

const isActive = $derived(session.status === 'active');

let diffDialogFields = $state<Record<string, string> | null>(null);
let diffDialog: HTMLDialogElement | undefined = $state();

function showDiff(fields: Record<string, string>) {
  diffDialogFields = fields;
  diffDialog?.showModal();
}

function closeDiff() {
  diffDialog?.close();
  diffDialogFields = null;
}

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
    messageContainer.scrollTop = 0;
  }
});
</script>

<div class="agent-chat" aria-label="Agent conversation">
  <form class="agent-chat__input-bar" onsubmit={(e) => handleSubmit(e)}>
    {#if !isActive}
      <div class="agent-chat__inactive-notice">
        Session {session.status}. Cannot send messages.
      </div>
    {:else}
      <textarea
        class="agent-chat__input"
        placeholder="Ask the AI to write or edit content..."
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </button>
    {/if}
  </form>

  <div
    class="agent-chat__messages"
    bind:this={messageContainer}
    role="log"
    aria-label="Conversation messages"
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
          <div class="agent-chat__bubble" class:agent-chat__bubble--user={isUser} class:agent-chat__bubble--agent={!isUser}>
            <div class="agent-chat__msg-content">
              {#if isUser}
                {msg.content}
              {:else}
                {#each parseAgentMessageBlocks(msg.content || '') as block}
                  {#if block.type === 'text'}
                    <span class="text-block">{block.content}</span>
                  {:else if block.type === 'fields'}
                    <div class="field-update-block">
                      <span class="applied-badge">✓ Updated {Object.keys(block.fields).length} field{Object.keys(block.fields).length !== 1 ? 's' : ''}</span>
                      <button class="diff-btn" type="button" onclick={() => showDiff(block.fields)}>Diff</button>
                    </div>
                  {:else if block.type === 'markdown'}
                    <div class="markdown-block">
                      <pre class="markdown-block__content"><code>{block.content}</code></pre>
                      {#if onapplychange}
                        <button
                          class="diff-btn"
                          type="button"
                          onclick={() => onapplychange(block.content)}
                        >
                          Apply
                        </button>
                      {/if}
                    </div>
                  {/if}
                {/each}
              {/if}
            </div>
            <time class="agent-chat__msg-time">{formatTime(msg.createdAt)}</time>
          </div>
        </div>
      {/if}
    {/each}

    {#if loading}
      <div class="agent-chat__msg agent-chat__msg--agent">
        <div class="agent-chat__bubble agent-chat__bubble--agent agent-chat__thinking">
          <span class="thinking-dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    {/if}

    {#if messages.length === 0 && !loading}
      <div class="agent-chat__empty">
        <span class="agent-chat__empty-text">Ask the AI to write or edit your content</span>
      </div>
    {/if}
  </div>
</div>

<!-- Diff Modal -->
<dialog bind:this={diffDialog} class="diff-dialog">
  <div class="diff-dialog__header">
    <h4>Field Changes</h4>
    <button class="diff-dialog__close" type="button" onclick={closeDiff}>✕</button>
  </div>
  {#if diffDialogFields}
    <div class="diff-dialog__body">
      {#each Object.entries(diffDialogFields) as [field, value]}
        <div class="diff-field">
          <span class="diff-field__name">{field}</span>
          <pre class="diff-field__value">{value}</pre>
        </div>
      {/each}
    </div>
  {/if}
</dialog>

<style>
  .agent-chat {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .agent-chat__messages {
    flex: 1;
    overflow-y: auto;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    display: flex;
    flex-direction: column-reverse;
    gap: var(--smrt-spacing-2, 8px);
  }

  .agent-chat__msg {
    display: flex;
    max-width: 95%;
  }

  .agent-chat__msg--user {
    align-self: flex-end;
  }

  .agent-chat__msg--agent {
    align-self: flex-start;
  }

  .agent-chat__msg--system {
    align-self: center;
    max-width: 90%;
  }

  .agent-chat__tool-row {
    width: 100%;
    padding: var(--smrt-spacing-1, 4px) 0;
  }

  .agent-chat__bubble {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-lg, 12px);
    word-break: break-word;
    font-size: 0.8125rem;
    line-height: 1.45;
  }

  .agent-chat__bubble--user {
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    border-bottom-right-radius: var(--smrt-radius-sm, 4px);
  }

  .agent-chat__bubble--agent {
    background: var(--smrt-color-surface-container-high, #e6e6ea);
    color: var(--smrt-color-on-surface, #1a1c1e);
    border-bottom-left-radius: var(--smrt-radius-sm, 4px);
  }

  .agent-chat__msg--system .agent-chat__bubble {
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-style: italic;
    text-align: center;
  }

  .agent-chat__msg-content {
    white-space: pre-wrap;
  }

  .agent-chat__msg-time {
    font-size: 0.5625rem;
    color: var(--smrt-color-outline, #74777f);
    align-self: flex-end;
    line-height: 1;
  }

  .agent-chat__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 80px;
  }

  .agent-chat__empty-text {
    font-size: 0.8125rem;
    color: var(--smrt-color-outline, #74777f);
  }

  .agent-chat__input-bar {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    background: var(--smrt-color-surface, #fefbff);
    flex-shrink: 0;
  }

  .agent-chat__inactive-notice {
    flex: 1;
    text-align: center;
    padding: var(--smrt-spacing-2, 8px);
    font-size: 0.75rem;
    color: var(--smrt-color-outline, #74777f);
    font-style: italic;
  }

  .agent-chat__input {
    flex: 1;
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font-size: 0.8125rem;
    line-height: 1.4;
    color: var(--smrt-color-on-surface, #1a1c1e);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    resize: none;
    outline: none;
    min-height: 34px;
    max-height: 80px;
  }

  .agent-chat__input:focus {
    outline: none;
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .agent-chat__input::placeholder {
    color: var(--smrt-color-outline, #74777f);
  }

  .agent-chat__send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: none;
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity 150ms;
  }

  .agent-chat__send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .agent-chat__send-btn:not(:disabled):hover {
    opacity: 0.85;
  }

  .applied-badge {
    display: inline-flex;
    align-items: center;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--smrt-color-on-success-container, #16a34a);
    background: var(--smrt-color-success-container, #f0fdf4);
    border: 1px solid var(--smrt-color-success, #bbf7d0);
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .field-update-block {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-1, 4px) 0;
  }

  .markdown-block {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-1, 4px) 0;
  }

  .markdown-block__content {
    margin: 0;
    padding: var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-lg, 12px);
    background: color-mix(in srgb, var(--smrt-color-surface-container-low, #f4f2f6) 85%, white);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.875rem;
    line-height: 1.45;
  }

  .diff-btn {
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    font-size: 0.625rem;
    font-weight: 600;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-full, 9999px);
    background: none;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    transition: background 0.15s;
  }

  .diff-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-primary, #005ac1);
  }

  .diff-dialog {
    border: none;
    border-radius: var(--smrt-radius-lg, 12px);
    padding: 0;
    width: min(420px, 90vw);
    max-height: 60vh;
    box-shadow: var(--smrt-elevation-5, 0 8px 32px color-mix(in srgb, var(--smrt-color-shadow) 18%, transparent));
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .diff-dialog::backdrop {
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.3));
  }

  .diff-dialog__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-4, 16px);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .diff-dialog__header h4 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }

  .diff-dialog__close {
    background: none;
    border: none;
    font-size: 1rem;
    cursor: pointer;
    color: var(--smrt-color-outline, #74777f);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-sm, 4px);
  }

  .diff-dialog__close:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .diff-dialog__body {
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-4, 16px);
    overflow-y: auto;
    max-height: calc(60vh - 60px);
  }

  .diff-field {
    margin-bottom: var(--smrt-spacing-3, 12px);
  }

  .diff-field:last-child {
    margin-bottom: 0;
  }

  .diff-field__name {
    display: block;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-outline, #74777f);
    margin-bottom: var(--smrt-spacing-1, 4px);
  }

  .diff-field__value {
    margin: 0;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font-size: 0.75rem;
    line-height: 1.5;
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    border-radius: var(--smrt-radius-md, 8px);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
    max-height: 200px;
    overflow-y: auto;
  }

  .agent-chat__thinking {
    padding: var(--smrt-spacing-3, 12px) var(--smrt-spacing-4, 16px);
  }

  .thinking-dots {
    display: inline-flex;
    gap: var(--smrt-spacing-1, 4px);
    align-items: center;
  }

  .thinking-dots span {
    width: 6px;
    height: 6px;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-outline, #74777f);
    animation: thinking-bounce 1.2s ease-in-out infinite;
  }

  .thinking-dots span:nth-child(2) {
    animation-delay: 0.15s;
  }

  .thinking-dots span:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes thinking-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-4px); opacity: 1; }
  }
</style>
