<script lang="ts">
/**
 * MiniChat - Compact chat window for tab mode
 * Simplified message list + input in minimal space.
 * No thread panel, no reactions. Just messages and a send box.
 */
import { Form, Input } from '@happyvertical/smrt-ui/forms';
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

<div class="smrt-mini-chat__root" data-smrt-component="MiniChat">
  <div
    class="smrt-mini-chat__messages"
    data-smrt-part="body"
    style:max-height="{maxHeight}px"
    bind:this={messageContainer}
    role="log"
    aria-label={t(M['chat.mini_chat.messages_label'])}
  >
    {#each messages as msg (msg.id)}
      {@const isOwn = msg.senderProfileId === currentProfileId}
      <div class="smrt-mini-chat__msg" data-smrt-part="row"
  class:smrt-mini-chat__msg--own={isOwn}
>
        {#if !isOwn}
          <Avatar name={msg.senderName} avatarUrl={msg.senderAvatarUrl} size="sm" />
        {/if}
        <div class="smrt-mini-chat__bubble" data-smrt-part="bubble"
  class:smrt-mini-chat__bubble--own={isOwn}
>
          {#if !isOwn}
            <span class="smrt-mini-chat__sender" data-smrt-part="label">{msg.senderName}</span>
          {/if}
          <span class="smrt-mini-chat__text" data-smrt-part="message">{msg.content}</span>
          <time class="smrt-mini-chat__time" data-smrt-part="meta">{formatTime(msg.createdAt)}</time>
        </div>
      </div>
    {/each}

    {#if messages.length === 0}
      <div class="smrt-mini-chat__empty" data-smrt-part="empty">
        <span class="smrt-mini-chat__empty-text" data-smrt-part="message">{t(M['chat.mini_chat.no_messages'])}</span>
      </div>
    {/if}
  </div>

  <Form onsubmit={handleSubmit}>
    <Input
      type="text"
      placeholder={t(M['chat.mini_chat.placeholder'])}
      bind:value={inputValue}
      onkeydown={handleKeydown}
      aria-label={t(M['chat.mini_chat.input_label'])}
    />
    <Button
      variant="ghost"
      type="submit"
      disabled={!inputValue.trim()}
      aria-label={t(M['chat.mini_chat.send'])}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
      </svg>
    </Button>
  </Form>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-mini-chat__root {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .smrt-mini-chat__messages {
    flex: 1;
    overflow-y: auto;
    padding: var(--smrt-spacing-2);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
  }
  .smrt-mini-chat__msg {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2);
    max-width: 85%;
  }
  .smrt-mini-chat__msg--own {
    align-self: flex-end;
    flex-direction: row-reverse;
  }
  .smrt-mini-chat__bubble {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    word-break: break-word;
  }
  .smrt-mini-chat__time {
    align-self: flex-end;
  }
  .smrt-mini-chat__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 80px;
  }
  /* :global() targets the Form primitive's rendered <form> (see #1589 scoping trap). */
  .smrt-mini-chat__root :global([data-smrt-component="Form"]) {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-2);
  }
  /* Layout for the Input primitive's rendered <input> (tokenised styling comes
  from the primitive; this only sizes/shapes it within the input bar). */
  .smrt-mini-chat__root :global([data-smrt-component="Input"]) {
    flex: 1;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589).
  The ancestor is the Form primitive's <form>, also global. */
  .smrt-mini-chat__root :global([data-smrt-component="Form"] [data-smrt-component="Button"]) {
    width: 32px;
    height: 32px;
    padding: 0;
    flex-shrink: 0;
  }
}

@layer smrt.theme {
  .smrt-mini-chat__messages {
    scroll-behavior: smooth;
  }
  .smrt-mini-chat__bubble {
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
  }
  .smrt-mini-chat__bubble--own {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-mini-chat__sender {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary);
    line-height: 1;
  }
  .smrt-mini-chat__text {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
  }
  .smrt-mini-chat__time {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-outline);
    line-height: 1;
  }
  .smrt-mini-chat__empty-text {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-outline);
  }
  /* :global() targets the Form primitive's rendered <form> (see #1589 scoping trap). */
  .smrt-mini-chat__root :global([data-smrt-component="Form"]) {
    border-top: var(--smrt-hairline);
    background: var(--smrt-color-surface);
  }
  /* Layout for the Input primitive's rendered <input> (tokenised styling comes
  from the primitive; this only sizes/shapes it within the input bar). */
  .smrt-mini-chat__root :global([data-smrt-component="Input"]) {
    border-radius: var(--smrt-radius-full);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589).
  The ancestor is the Form primitive's <form>, also global. */
  .smrt-mini-chat__root :global([data-smrt-component="Form"] [data-smrt-component="Button"]) {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-radius: var(--smrt-radius-full);
    transition: opacity var(--smrt-duration-short2, 150ms);
  }
  .smrt-mini-chat__root :global([data-smrt-component="Form"] [data-smrt-component="Button"]:disabled) {
    opacity: 0.4;
  }
  .smrt-mini-chat__root :global([data-smrt-component="Form"] [data-smrt-component="Button"]:not(:disabled):hover) {
    background: var(--smrt-color-primary);
    opacity: 0.85;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-mini-chat__messages {
      scroll-behavior: auto;
    }
    .smrt-mini-chat__root :global([data-smrt-component="Form"] [data-smrt-component="Button"]) {
      transition: none;
    }
  }
}

</style>
