<script lang="ts">
/**
 * AgentChat - Full agent conversation interface
 * Shows agent info header, message list with tool call displays, and input bar.
 * Agent messages are styled differently from user messages.
 */

import { Form, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';
import type {
  AgentSessionData,
  ChatMessageData,
  ToolCallDisplayData,
} from '../../types.js';
import Avatar from '../shared/Avatar.svelte';
import { parseAgentMessageBlocks } from './message-blocks.js';
import ToolCallDisplay from './ToolCallDisplay.svelte';

const { t } = useI18n();

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

<div class="smrt-agent-chat__root" aria-label={t(M['chat.agent_chat.conversation'])} data-smrt-component="AgentChat">
  <Form onsubmit={(e) => handleSubmit(e)}>
    {#if !isActive}
      <div class="smrt-agent-chat__notice" data-smrt-part="status">
        {t(M['chat.agent_chat.inactive_notice'], { status: session.status })}
      </div>
    {:else}
      <Textarea
        placeholder={t(M['chat.agent_chat.input_placeholder'])}
        bind:value={inputValue}
        onkeydown={handleKeydown}
        rows={1}
        disabled={!isActive}
        aria-label={t(M['chat.agent_chat.message_input'])}
      />
      <Button
        variant="ghost"
        type="submit"
        disabled={!inputValue.trim() || !isActive}
        aria-label={t(M['chat.agent_chat.send_message'])}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </Button>
    {/if}
  </Form>

  <div
    class="smrt-agent-chat__messages"
    data-smrt-part="body"
    bind:this={messageContainer}
    role="log"
    aria-label={t(M['chat.agent_chat.messages'])}
  >
    {#each messages as msg (msg.id)}
      {@const isUser = msg.role === 'user'}
      {@const isToolCall = msg.messageType === 'tool_call' || msg.messageType === 'tool_result'}

      {#if isToolCall && msg.toolCallData}
        <div class="smrt-agent-chat__tool" data-smrt-part="panel">
          <ToolCallDisplay toolCall={msg.toolCallData} />
        </div>
      {:else}
        <div
          class="smrt-agent-chat__msg"
          data-smrt-part="row"
        
  class:smrt-agent-chat__msg--user={isUser}
  class:smrt-agent-chat__msg--agent={!isUser && !isToolCall}
  class:smrt-agent-chat__msg--system={msg.role === 'system'}
>
          <div class="smrt-agent-chat__bubble" data-smrt-part="body"
  class:smrt-agent-chat__bubble--user={isUser}
  class:smrt-agent-chat__bubble--agent={!isUser}
>
            <div class="smrt-agent-chat__message" data-smrt-part="message">
              {#if isUser}
                {msg.content}
              {:else}
                {#each parseAgentMessageBlocks(msg.content || '') as block}
                  {#if block.type === 'text'}
                    <span class="smrt-agent-chat__text" data-smrt-part="message">{block.content}</span>
                  {:else if block.type === 'fields'}
                    <div class="smrt-agent-chat__field-update" data-smrt-part="panel">
                      <span class="smrt-agent-chat__badge" data-smrt-part="badge">{t(M['chat.agent_chat.updated_fields'], { count: Object.keys(block.fields).length, plural: Object.keys(block.fields).length !== 1 ? 's' : '' })}</span>
                      <Button variant="ghost" size="sm" type="button" onclick={() => showDiff(block.fields)}>Diff</Button>
                    </div>
                  {:else if block.type === 'markdown'}
                    <div class="smrt-agent-chat__markdown" data-smrt-part="body">
                      <pre class="smrt-agent-chat__markdown-content" data-smrt-part="body"><code>{block.content}</code></pre>
                      {#if onapplychange}
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onclick={() => onapplychange(block.content)}
                        >
                          Apply
                        </Button>
                      {/if}
                    </div>
                  {/if}
                {/each}
              {/if}
            </div>
            <time class="smrt-agent-chat__msg-time" data-smrt-part="time">{formatTime(msg.createdAt)}</time>
          </div>
        </div>
      {/if}
    {/each}

    {#if loading}
      <div class="smrt-agent-chat__msg smrt-agent-chat__msg--agent" data-smrt-part="row">
        <div class="smrt-agent-chat__bubble smrt-agent-chat__bubble--agent smrt-agent-chat__thinking" data-smrt-part="body">
          <span class="smrt-agent-chat__thinking-dots" data-smrt-part="indicator">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    {/if}

    {#if messages.length === 0 && !loading}
      <div class="smrt-agent-chat__empty" data-smrt-part="empty">
        <span class="smrt-agent-chat__empty-text" data-smrt-part="message">{t(M['chat.agent_chat.empty'])}</span>
      </div>
    {/if}
  </div>
</div>

<!-- Diff Modal -->
<dialog bind:this={diffDialog} class="smrt-agent-chat__dialog" data-smrt-component="AgentChat">
  <div class="smrt-agent-chat__dialog-header" data-smrt-part="header">
    <h4>{t(M['chat.agent_chat.field_changes'])}</h4>
    <Button variant="ghost" size="sm" type="button" onclick={closeDiff}>✕</Button>
  </div>
  {#if diffDialogFields}
    <div class="smrt-agent-chat__dialog-body" data-smrt-part="body">
      {#each Object.entries(diffDialogFields) as [field, value]}
        <div class="smrt-agent-chat__field" data-smrt-part="field">
          <span class="smrt-agent-chat__field-name" data-smrt-part="label">{field}</span>
          <pre class="smrt-agent-chat__field-value" data-smrt-part="value">{value}</pre>
        </div>
      {/each}
    </div>
  {/if}
</dialog>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-agent-chat__root {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .smrt-agent-chat__messages {
    flex: 1;
    overflow-y: auto;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    display: flex;
    flex-direction: column-reverse;
    gap: var(--smrt-spacing-2);
  }
  .smrt-agent-chat__msg {
    display: flex;
    max-width: 95%;
  }
  .smrt-agent-chat__msg--user {
    align-self: flex-end;
  }
  .smrt-agent-chat__msg--agent {
    align-self: flex-start;
  }
  .smrt-agent-chat__msg--system {
    align-self: center;
    max-width: 90%;
  }
  .smrt-agent-chat__tool {
    width: 100%;
    padding: var(--smrt-spacing-1) 0;
  }
  .smrt-agent-chat__bubble {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    word-break: break-word;
  }
  .smrt-agent-chat__message {
    white-space: pre-wrap;
  }
  .smrt-agent-chat__msg-time {
    align-self: flex-end;
  }
  .smrt-agent-chat__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 80px;
  }
  /* :global() targets the Form primitive's rendered <form> (see #1589 scoping trap). */
  :global(:where([data-smrt-component="AgentChat"]) [data-smrt-component="Form"]) {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    flex-shrink: 0;
  }
  .smrt-agent-chat__notice {
    flex: 1;
    padding: var(--smrt-spacing-2);
  }
  /* Layout for the Textarea primitive's rendered <textarea> (tokenised styling
  comes from the primitive; this only sizes it within the input bar). */
  :global(:where([data-smrt-component="AgentChat"]) [data-smrt-component="Textarea"]) {
    flex: 1;
    resize: none;
    min-height: 34px;
    max-height: 80px;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589).
  The ancestor is the Form primitive's <form>, also global. */
  :global(:where([data-smrt-component="AgentChat"]) [data-smrt-component="Form"] [data-smrt-component="Button"]) {
    width: 34px;
    height: 34px;
    padding: 0;
    flex-shrink: 0;
  }
  .smrt-agent-chat__badge {
    display: inline-flex;
    align-items: center;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-agent-chat__field-update {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-1) 0;
  }
  .smrt-agent-chat__markdown {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-1) 0;
  }
  .smrt-agent-chat__markdown-content {
    margin: 0;
    padding: var(--smrt-spacing-3);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-agent-chat__field-update :global([data-smrt-component="Button"]),
  .smrt-agent-chat__markdown :global([data-smrt-component="Button"]) {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-agent-chat__dialog {
    padding: 0;
    width: min(420px, 90vw);
    max-height: 60vh;
  }
  .smrt-agent-chat__dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
  }
  .smrt-agent-chat__dialog-header h4 {
    margin: 0;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-agent-chat__dialog-header :global([data-smrt-component="Button"]) {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-agent-chat__dialog-body {
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
    overflow-y: auto;
    max-height: calc(60vh - 60px);
  }
  .smrt-agent-chat__field {
    margin-bottom: var(--smrt-spacing-3);
  }
  .smrt-agent-chat__field:last-child {
    margin-bottom: 0;
  }
  .smrt-agent-chat__field-name {
    display: block;
    margin-bottom: var(--smrt-spacing-1);
  }
  .smrt-agent-chat__field-value {
    margin: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }
  .smrt-agent-chat__thinking {
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
  }
  .smrt-agent-chat__thinking-dots {
    display: inline-flex;
    gap: var(--smrt-spacing-1);
    align-items: center;
  }
  .smrt-agent-chat__thinking-dots span {
    width: 6px;
    height: 6px;
  }
}

@layer smrt.theme {
  .smrt-agent-chat__root {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-agent-chat__bubble {
    border-radius: var(--smrt-radius-lg);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    line-height: var(--smrt-typography-body-medium-line-height, 1.45);
  }
  .smrt-agent-chat__bubble--user {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    border-bottom-right-radius: var(--smrt-radius-sm);
  }
  .smrt-agent-chat__bubble--agent {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
    border-bottom-left-radius: var(--smrt-radius-sm);
  }
  .smrt-agent-chat__msg--system .smrt-agent-chat__bubble {
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
    text-align: center;
  }
  .smrt-agent-chat__msg-time {
    font-size: var(--smrt-typography-label-small-size, 0.5625rem);
    color: var(--smrt-color-outline);
    line-height: 1;
  }
  .smrt-agent-chat__empty-text {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-outline);
  }
  /* :global() targets the Form primitive's rendered <form> (see #1589 scoping trap). */
  :global(:where([data-smrt-component="AgentChat"]) [data-smrt-component="Form"]) {
    background: var(--smrt-color-surface);
  }
  .smrt-agent-chat__notice {
    text-align: center;
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-outline);
    font-style: italic;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589).
  The ancestor is the Form primitive's <form>, also global. */
  :global(:where([data-smrt-component="AgentChat"]) [data-smrt-component="Form"] [data-smrt-component="Button"]) {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-radius: var(--smrt-radius-full);
    transition: opacity 150ms;
  }
  :global(:where([data-smrt-component="AgentChat"]) [data-smrt-component="Form"] [data-smrt-component="Button"]:not(:disabled):hover) {
    background: var(--smrt-color-primary);
    opacity: 0.85;
  }
  .smrt-agent-chat__badge {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-success-container);
    background: var(--smrt-color-success-container);
    border: 1px solid var(--smrt-color-success);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-agent-chat__markdown-content {
    border-radius: var(--smrt-radius-lg);
    background: color-mix(in srgb, var(--smrt-color-surface-container-low) 85%, white);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    line-height: var(--smrt-typography-body-medium-line-height, 1.45);
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-agent-chat__field-update :global([data-smrt-component="Button"]),
  .smrt-agent-chat__markdown :global([data-smrt-component="Button"]) {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-full);
    background: none;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-chat__field-update :global([data-smrt-component="Button"]:hover),
  .smrt-agent-chat__markdown :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-primary);
  }
  .smrt-agent-chat__dialog {
    border: none;
    border-radius: var(--smrt-radius-lg);
    box-shadow: var(--smrt-elevation-5, 0 8px 32px color-mix(in srgb, var(--smrt-color-shadow) 18%, transparent));
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-agent-chat__dialog::backdrop {
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.3));
  }
  .smrt-agent-chat__dialog-header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-agent-chat__dialog-header h4 {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-agent-chat__dialog-header :global([data-smrt-component="Button"]) {
    background: none;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    color: var(--smrt-color-outline);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-agent-chat__dialog-header :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-agent-chat__field-name {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.04em);
    color: var(--smrt-color-outline);
  }
  .smrt-agent-chat__field-value {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    line-height: var(--smrt-typography-body-small-line-height, 1.5);
    background: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-md);
    font-family: inherit;
  }
  .smrt-agent-chat__thinking-dots span {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-outline);
    animation: thinking-bounce 1.2s ease-in-out infinite;
  }
  .smrt-agent-chat__thinking-dots span:nth-child(2) {
    animation-delay: 0.15s;
  }
  .smrt-agent-chat__thinking-dots span:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes thinking-bounce {
    0%, 60%, 100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    30% {
      transform: translateY(-4px);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-agent-chat__thinking-dots span {
      animation: none;
    }
  }
}

</style>
