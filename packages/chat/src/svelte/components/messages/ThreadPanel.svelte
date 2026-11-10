<script lang="ts">
/**
 * ThreadPanel - Side panel for threaded conversation
 * Shows the root message, thread replies, and an input for new replies.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.messages.js';
import type { ChatMessageData, ChatThreadData } from '../../types.js';
import MessageInput from './MessageInput.svelte';
import MessageList from './MessageList.svelte';

const { t } = useI18n();

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

<aside class="smrt-thread-panel__root" aria-label={t(M['chat.thread_panel.thread_label'], { title: threadTitle })} data-smrt-component="ThreadPanel">
  <header class="smrt-thread-panel__header" data-smrt-part="header">
    <div class="smrt-thread-panel__header-text" data-smrt-part="heading">
      <h3 class="smrt-thread-panel__title" data-smrt-part="title">{threadTitle}</h3>
      <span class="smrt-thread-panel__meta" data-smrt-part="meta">
        {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        {#if thread.participantCount > 0}
          &middot; {thread.participantCount} {thread.participantCount === 1 ? 'participant' : 'participants'}
        {/if}
      </span>
    </div>
    {#if thread.isResolved}
      <span class="smrt-thread-panel__resolved" data-smrt-part="badge">Resolved</span>
    {/if}
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onclick={onclose}
      aria-label={t(M['chat.thread_panel.close'])}
    >
      <svg viewBox="0 0 16 16" width="16" height="16">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </Button>
  </header>

  <div class="smrt-thread-panel__messages" data-smrt-part="body">
    <MessageList
      {messages}
      {currentProfileId}
    />
  </div>

  <div class="smrt-thread-panel__input" data-smrt-part="footer">
    <MessageInput
      {onsend}
      placeholder={t(M['chat.thread_panel.reply_placeholder'])}
    />
  </div>
</aside>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-thread-panel__root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
  }
  .smrt-thread-panel__header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-4, 1rem);
    flex-shrink: 0;
  }
  .smrt-thread-panel__header-text {
    flex: 1;
    min-width: 0;
  }
  .smrt-thread-panel__title {
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-thread-panel__resolved {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    white-space: nowrap;
    flex-shrink: 0;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-thread-panel__header :global([data-smrt-component="Button"]) {
    width: 32px;
    height: 32px;
    padding: 0;
    flex-shrink: 0;
  }
  .smrt-thread-panel__messages {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .smrt-thread-panel__input {
    flex-shrink: 0;
  }
}

@layer smrt.theme {
  .smrt-thread-panel__root {
    background: var(--smrt-color-surface);
    border-left: var(--smrt-hairline);
  }
  .smrt-thread-panel__header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-thread-panel__title {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-thread-panel__meta {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-thread-panel__resolved {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-success-container);
    background: var(--smrt-color-success-container);
    border-radius: var(--smrt-radius-full);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-thread-panel__header :global([data-smrt-component="Button"]) {
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-thread-panel__header :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-container-high);
  }
}

</style>
