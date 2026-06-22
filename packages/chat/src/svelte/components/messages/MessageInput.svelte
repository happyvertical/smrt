<script lang="ts">
/**
 * MessageInput - Chat message input bar
 * Text area with send button. Shows reply preview when replying.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.messages.js';

const { t } = useI18n();

export interface Props {
  /** Callback when a message is sent */
  onsend: (content: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Disable the input */
  disabled?: boolean;
  /** Reply context if replying to a message */
  replyTo?: { id: string; senderName: string; content: string } | null;
  /** Cancel reply callback */
  oncancelreply?: () => void;
}

const {
  onsend,
  placeholder = 'Type a message...',
  disabled = false,
  replyTo = null,
  oncancelreply,
}: Props = $props();

let content = $state('');
let textareaEl: HTMLTextAreaElement | undefined = $state();

function handleSend() {
  const trimmed = content.trim();
  if (!trimmed || disabled) return;
  onsend(trimmed);
  content = '';
  if (textareaEl) {
    textareaEl.style.height = 'auto';
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

function handleInput() {
  if (!textareaEl) return;
  textareaEl.style.height = 'auto';
  textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 120)}px`;
}
</script>

<div class="message-input" class:disabled>
  {#if replyTo}
    <div class="message-input__reply">
      <div class="message-input__reply-body">
        <span class="message-input__reply-name">{replyTo.senderName}</span>
        <span class="message-input__reply-text">{replyTo.content}</span>
      </div>
      {#if oncancelreply}
        <button
          class="message-input__reply-close"
          type="button"
          onclick={oncancelreply}
          aria-label={t(M['chat.message_input.cancel_reply'])}
        >
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      {/if}
    </div>
  {/if}

  <div class="message-input__bar">
    <textarea
      bind:this={textareaEl}
      bind:value={content}
      class="message-input__textarea"
      {placeholder}
      {disabled}
      rows="1"
      onkeydown={handleKeydown}
      oninput={handleInput}
      aria-label={t(M['chat.message_input.input_label'])}
    ></textarea>
    <button
      class="message-input__send"
      type="button"
      onclick={handleSend}
      disabled={disabled || content.trim().length === 0}
      aria-label={t(M['chat.message_input.send'])}
    >
      <svg viewBox="0 0 20 20" width="18" height="18">
        <path
          d="M3.5 10L2 3l16 7-16 7 1.5-7zm0 0h7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
</div>

<style>
  .message-input {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    background: var(--smrt-color-surface, #ffffff);
  }

  .message-input.disabled {
    opacity: 0.6;
    pointer-events: none;
  }

  .message-input__reply {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-4, 1rem);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .message-input__reply-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    min-width: 0;
    border-left: 2px solid var(--smrt-color-primary, #005ac1);
    padding-left: var(--smrt-spacing-2, 0.375rem);
  }

  .message-input__reply-name {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary, #005ac1);
  }

  .message-input__reply-text {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .message-input__reply-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    flex-shrink: 0;
  }

  .message-input__reply-close:hover {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
  }

  .message-input__bar {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
  }

  .message-input__textarea {
    flex: 1;
    resize: none;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-family: inherit;
    line-height: 1.4;
    background: var(--smrt-color-surface-container-low, #f9fafb);
    color: var(--smrt-color-on-surface, #1b1b1f);
    max-height: 120px;
    overflow-y: auto;
  }

  .message-input__textarea:focus {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -1px;
    border-color: transparent;
  }

  .message-input__textarea::placeholder {
    color: var(--smrt-color-outline, #74777f);
  }

  .message-input__send {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .message-input__send:hover:not(:disabled) {
    background: color-mix(in srgb, var(--smrt-color-primary, #005ac1) 85%, var(--smrt-color-shadow, #000));
  }

  .message-input__send:disabled {
    background: var(--smrt-color-surface-container-high, #e1e3e8);
    color: var(--smrt-color-outline, #74777f);
    cursor: not-allowed;
  }
</style>
