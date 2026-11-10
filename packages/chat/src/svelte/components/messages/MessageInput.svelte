<script lang="ts">
/**
 * MessageInput - Chat message input bar
 * Text area with send button. Shows reply preview when replying.
 */
import { Textarea } from '@happyvertical/smrt-ui/forms';
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
// Captured from the textarea's input event so auto-resize works without binding
// to the Textarea primitive's inner DOM node (the primitive doesn't expose it).
let textareaEl: HTMLTextAreaElement | undefined;

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

function handleInput(event: Event) {
  const el = event.currentTarget as HTMLTextAreaElement;
  textareaEl = el;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}
</script>

<div class="smrt-message-input__root" data-smrt-component="MessageInput"
  class:smrt-message-input__disabled={disabled}
>
  {#if replyTo}
    <div class="smrt-message-input__reply" data-smrt-part="reply">
      <div class="smrt-message-input__reply-body" data-smrt-part="body">
        <span class="smrt-message-input__reply-name" data-smrt-part="label">{replyTo.senderName}</span>
        <span class="smrt-message-input__reply-text" data-smrt-part="message">{replyTo.content}</span>
      </div>
      {#if oncancelreply}
        <!-- raw-primitive-allow: compact icon-only composer control; uses the component's local button geometry and avoids wrapper event forwarding in the dev-server browser path -->
        <button
          class="smrt-message-input__close"
          data-smrt-part="close"
          type="button"
          onclick={oncancelreply}
          aria-label={t(M['chat.message_input.cancel_reply'])}
        >
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        </button>
      {/if}
    </div>
  {/if}

  <div class="smrt-message-input__bar" data-smrt-part="composer">
    <Textarea
      bind:value={content}
      {placeholder}
      {disabled}
      rows={1}
      onkeydown={handleKeydown}
      oninput={handleInput}
      aria-label={t(M['chat.message_input.input_label'])}
    />
    <!-- raw-primitive-allow: compact icon-only composer submit control; native button is required so pointer clicks and Enter-submit share the same local handler in package dev servers -->
    <button
      class="smrt-message-input__send"
      data-smrt-part="submit"
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-input__root {
    display: flex;
    flex-direction: column;
  }
  .smrt-message-input__root.smrt-message-input__disabled {
    pointer-events: none;
  }
  .smrt-message-input__reply {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-2, 0.375rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-message-input__reply-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    min-width: 0;
    padding-left: var(--smrt-spacing-2, 0.375rem);
  }
  .smrt-message-input__reply-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-message-input__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  .smrt-message-input__bar {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 0.375rem);
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
  }
  /* Layout/sizing for the Textarea primitive's rendered <textarea>; tokenised
  border/focus/placeholder styling comes from the primitive. The height is
  JS-driven (auto-resize), so resize is disabled and capped at max-height. */
  .smrt-message-input__bar :global([data-smrt-component="Textarea"]) {
    flex: 1;
    resize: none;
    min-height: auto;
    max-height: 120px;
    overflow-y: auto;
  }
  .smrt-message-input__send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }
  .smrt-message-input__send:disabled {
    cursor: default;
  }
}

@layer smrt.theme {
  .smrt-message-input__root {
    border-top: var(--smrt-hairline);
    background: var(--smrt-color-surface);
  }
  .smrt-message-input__root.smrt-message-input__disabled {
    opacity: 0.6;
  }
  .smrt-message-input__reply {
    background: var(--smrt-color-surface-container-low);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-message-input__reply-body {
    border-left: 2px solid var(--smrt-color-primary);
  }
  .smrt-message-input__reply-name {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-primary);
  }
  .smrt-message-input__reply-text {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-input__close {
    border: 0;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-input__close:hover {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-message-input__send {
    border: 0;
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-message-input__send:hover:not(:disabled) {
    background: color-mix(in srgb, var(--smrt-color-primary) 85%, var(--smrt-color-shadow));
  }
  .smrt-message-input__send:disabled {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-outline);
  }
}

</style>
