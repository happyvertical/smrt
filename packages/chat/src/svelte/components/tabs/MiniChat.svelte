<script lang="ts">
/**
 * MiniChat - Compact chat window for tab mode
 * Simplified message list + input in minimal space.
 * No thread panel, no reactions. Just messages and a send box.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.messages.js';
import type { ChatMessageData } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';

const { t } = useI18n();

export interface Props {
  /** Messages to display */
  messages: ChatMessageData[];
  /** Current user's profile ID */
  currentProfileId: string;
  /** Send a message */
  onsend: (content: string) => void;
  /** Maximum height for the message area in px */
  maxHeight?: number;
}

const { messages, currentProfileId, onsend, maxHeight = 360 }: Props = $props();

let inputValue = $state('');
let messageContainer: HTMLDivElement | undefined = $state();

function handleSubmit(event: Event) {
  event.preventDefault();
  const trimmed = inputValue.trim();
  if (!trimmed) return;
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

<div class="mini-chat">
  <div
    class="mini-chat__messages"
    style:max-height="{maxHeight}px"
    bind:this={messageContainer}
    role="log"
    aria-label={t(M['chat.mini_chat.messages_label'])}
  >
    {#each messages as msg (msg.id)}
      {@const isOwn = msg.senderProfileId === currentProfileId}
      <div class="mini-chat__msg" class:mini-chat__msg--own={isOwn}>
        {#if !isOwn}
          <Avatar name={msg.senderName} avatarUrl={msg.senderAvatarUrl} size="sm" />
        {/if}
        <div class="mini-chat__bubble" class:mini-chat__bubble--own={isOwn}>
          {#if !isOwn}
            <span class="mini-chat__sender">{msg.senderName}</span>
          {/if}
          <span class="mini-chat__text">{msg.content}</span>
          <time class="mini-chat__time">{formatTime(msg.createdAt)}</time>
        </div>
      </div>
    {/each}

    {#if messages.length === 0}
      <div class="mini-chat__empty">
        <span class="mini-chat__empty-text">{t(M['chat.mini_chat.no_messages'])}</span>
      </div>
    {/if}
  </div>

  <form class="mini-chat__input-bar" onsubmit={handleSubmit}>
    <input
      class="mini-chat__input"
      type="text"
      placeholder={t(M['chat.mini_chat.placeholder'])}
      bind:value={inputValue}
      onkeydown={handleKeydown}
      aria-label={t(M['chat.mini_chat.input_label'])}
    />
    <Button
      variant="ghost"
      class="mini-chat__send-btn"
      type="submit"
      disabled={!inputValue.trim()}
      aria-label={t(M['chat.mini_chat.send'])}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
      </svg>
    </Button>
  </form>
</div>

<style>
  .mini-chat {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .mini-chat__messages {
    flex: 1;
    overflow-y: auto;
    padding: var(--smrt-spacing-2, 8px);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
    scroll-behavior: smooth;
  }

  .mini-chat__msg {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2, 8px);
    max-width: 85%;
  }

  .mini-chat__msg--own {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .mini-chat__bubble {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--smrt-color-surface-container, #f0f0f4);
    color: var(--smrt-color-on-surface, #1a1c1e);
    word-break: break-word;
  }

  .mini-chat__bubble--own {
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
  }

  .mini-chat__sender {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary, #005ac1);
    line-height: 1;
  }

  .mini-chat__text {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }

  .mini-chat__time {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-outline, #74777f);
    align-self: flex-end;
    line-height: 1;
  }

  .mini-chat__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 80px;
  }

  .mini-chat__empty-text {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  .mini-chat__input-bar {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    padding: var(--smrt-spacing-2, 8px);
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    background: var(--smrt-color-surface, #fefbff);
  }

  .mini-chat__input {
    flex: 1;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-full, 9999px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    outline: none;
  }

  .mini-chat__input:focus {
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 1px var(--smrt-color-primary, #005ac1);
  }

  .mini-chat__input::placeholder {
    color: var(--smrt-color-outline, #74777f);
  }

  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .mini-chat__input-bar :global(.mini-chat__send-btn) {
    width: 32px;
    height: 32px;
    padding: 0;
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border-radius: var(--smrt-radius-full, 9999px);
    flex-shrink: 0;
    transition: opacity var(--smrt-duration-short2, 150ms);
  }

  .mini-chat__input-bar :global(.mini-chat__send-btn:disabled) {
    opacity: 0.4;
  }

  .mini-chat__input-bar :global(.mini-chat__send-btn:not(:disabled):hover) {
    background: var(--smrt-color-primary, #005ac1);
    opacity: 0.85;
  }

  @media (prefers-reduced-motion: reduce) {
    .mini-chat__messages {
      scroll-behavior: auto;
    }

    .mini-chat__input-bar :global(.mini-chat__send-btn) {
      transition: none;
    }
  }
</style>
