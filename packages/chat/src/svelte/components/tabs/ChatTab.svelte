<script lang="ts">
/**
 * ChatTab - Individual collapsible chat window
 * Compact header with title, collapse/close buttons. Contains message list and input.
 * Expands upward from the bottom tab bar.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.messages.js';
import type { ChatMessageData, ChatTabState } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';
import MiniChat from './MiniChat.svelte';

const { t } = useI18n();

export interface Props {
  /** Tab state */
  tab: ChatTabState;
  /** Messages in this chat */
  messages: ChatMessageData[];
  /** Current user's profile ID */
  currentProfileId: string;
  /** Send a message */
  onsend: (content: string) => void;
  /** Collapse this tab */
  oncollapse: () => void;
  /** Close this tab */
  onclose: () => void;
  /** Expand this tab */
  onexpand: () => void;
}

const {
  tab,
  messages,
  currentProfileId,
  onsend,
  oncollapse,
  onclose,
  onexpand,
}: Props = $props();
</script>

{#if tab.isExpanded}
  <div class="chat-tab chat-tab--expanded" aria-label={t(M['chat.chat_tab.chat_with'], { name: tab.room.name })}>
    <div class="chat-tab__header">
      <button
        class="chat-tab__header-btn"
        type="button"
        onclick={oncollapse}
        aria-label={t(M['chat.chat_tab.collapse'])}
      >
        <Avatar
          name={tab.room.name}
          avatarUrl={tab.room.avatarUrl}
          size="sm"
        />
        <span class="chat-tab__name">{tab.room.name}</span>
      </button>

      <div class="chat-tab__actions">
        <button
          class="chat-tab__icon-btn"
          type="button"
          onclick={oncollapse}
          aria-label={t(M['chat.chat_tab.minimize'])}
          title={t(M['chat.chat_tab.minimize'])}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="3" y="12" width="10" height="2" rx="1" />
          </svg>
        </button>
        <button
          class="chat-tab__icon-btn"
          type="button"
          onclick={onclose}
          aria-label={t(M['chat.chat_tab.close'])}
          title={t(M['chat.chat_tab.close'])}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>
      </div>
    </div>

    <div class="chat-tab__body">
      <MiniChat
        {messages}
        {currentProfileId}
        {onsend}
        maxHeight={320}
      />
    </div>
  </div>
{:else}
  <button
    class="chat-tab chat-tab--collapsed"
    type="button"
    onclick={onexpand}
    aria-label={t(M['chat.chat_tab.open_chat_with'], { name: tab.room.name })}
  >
    <Avatar
      name={tab.room.name}
      avatarUrl={tab.room.avatarUrl}
      size="sm"
    />
    <span class="chat-tab__name">{tab.room.name}</span>
    {#if tab.unreadCount > 0}
      <span class="chat-tab__badge" aria-label={t(M['chat.chat_tab.unread'], { count: tab.unreadCount })}>{tab.unreadCount}</span>
    {/if}
  </button>
{/if}

<style>
  .chat-tab--expanded {
    display: flex;
    flex-direction: column;
    width: 328px;
    background: var(--smrt-color-surface, #fefbff);
    border-radius: var(--smrt-radius-large, 12px) var(--smrt-radius-large, 12px) 0 0;
    box-shadow: var(--smrt-elevation-3, 0 4px 8px rgba(0, 0, 0, 0.15));
    overflow: hidden;
  }

  .chat-tab__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    min-height: 44px;
  }

  .chat-tab__header-btn {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0;
    min-width: 0;
  }

  .chat-tab__header-btn:focus-visible {
    outline: 2px solid var(--smrt-color-on-primary, #ffffff);
    outline-offset: 2px;
    border-radius: var(--smrt-radius-small, 4px);
  }

  .chat-tab__name {
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .chat-tab__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    flex-shrink: 0;
  }

  .chat-tab__icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    border-radius: var(--smrt-radius-full, 9999px);
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .chat-tab__icon-btn:hover {
    background: color-mix(in srgb, var(--smrt-color-on-primary) 15%, transparent);
  }

  .chat-tab__icon-btn:focus-visible {
    outline: 2px solid var(--smrt-color-on-primary, #ffffff);
    outline-offset: -2px;
  }

  .chat-tab__body {
    flex: 1;
    min-height: 0;
  }

  .chat-tab--collapsed {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    background: var(--smrt-color-surface-container, #f0f0f4);
    border: none;
    border-radius: var(--smrt-radius-large, 12px) var(--smrt-radius-large, 12px) 0 0;
    cursor: pointer;
    box-shadow: var(--smrt-elevation-2, 0 2px 6px rgba(0, 0, 0, 0.1));
    color: var(--smrt-color-on-surface, #1a1c1e);
    transition: background var(--smrt-duration-short2, 150ms);
    white-space: nowrap;
  }

  .chat-tab--collapsed:hover {
    background: var(--smrt-color-surface-container-high, #e6e6ea);
  }

  .chat-tab--collapsed:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .chat-tab__badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-error, #ba1a1a);
    color: var(--smrt-color-on-error, #ffffff);
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    line-height: 1;
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-tab--collapsed,
    .chat-tab__icon-btn {
      transition: none;
    }
  }
</style>
