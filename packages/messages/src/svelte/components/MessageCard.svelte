<script lang="ts">
/**
 * MessageCard - Single message row with type-adaptive rendering
 */

import type { Snippet } from 'svelte';
import type { AccountData, MessageData } from '../types.js';
import MessageStatusIndicator from './MessageStatusIndicator.svelte';
import MessageTypeBadge from './MessageTypeBadge.svelte';

export interface Props {
  message: MessageData;
  selected?: boolean;
  compact?: boolean;
  showAccount?: boolean;
  showType?: boolean;
  onclick?: (message: MessageData) => void;
  onselect?: (message: MessageData) => void;
  onflag?: (message: MessageData) => void;
  account?: AccountData;
  typeContent?: Snippet<[{ message: MessageData }]>;
}

const {
  message,
  selected = false,
  compact = false,
  showAccount = false,
  showType = true,
  onclick,
  onselect,
  onflag,
  account,
  typeContent,
}: Props = $props();

const _formattedDate = $derived.by(() => {
  if (!message.date) return '';
  const d =
    typeof message.date === 'string' ? new Date(message.date) : message.date;
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
});

const _preview = $derived.by(() => {
  const text = message.body || '';
  if (text.length <= 120) return text;
  return `${text.slice(0, 120)}...`;
});

const _emailMeta = $derived.by(() => {
  if (message.type !== 'email') return null;
  return {
    folderPath: message.folderPath,
    ccCount: message.ccAddresses?.length || 0,
  };
});

const _tweetMeta = $derived.by(() => {
  if (message.type !== 'tweet') return null;
  const meta = message.meta || {};
  return {
    retweetCount: meta.retweetCount || 0,
    likeCount: meta.likeCount || 0,
    replyCount: meta.replyCount || 0,
  };
});

const _slackMeta = $derived.by(() => {
  if (message.type !== 'slack') return null;
  const meta = message.meta || {};
  return {
    channelName: meta.channelName || '',
    reactions: meta.reactions || [],
  };
});
</script>

<div
  class="message-card"
  class:message-card--selected={selected}
  class:message-card--unread={!message.isRead}
  class:message-card--compact={compact}
  role="row"
  aria-selected={selected}
>
  {#if onselect}
    <div class="select-col">
      <input
        type="checkbox"
        checked={selected}
        onchange={() => onselect?.(message)}
        aria-label="Select message"
      />
    </div>
  {/if}

  <button
    class="message-content"
    type="button"
    onclick={() => onclick?.(message)}
  >
    <div class="header-row">
      <div class="sender">
        <span class="sender-name" class:sender-name--unread={!message.isRead}>
          {message.senderName || message.senderAddress}
        </span>
        {#if showAccount && account}
          <span class="account-label">{account.name}</span>
        {/if}
      </div>
      <div class="header-right">
        <MessageStatusIndicator
          isRead={message.isRead}
          isFlagged={message.isFlagged}
          hasAttachments={message.hasAttachments}
        />
        <time class="date">{_formattedDate}</time>
      </div>
    </div>

    <div class="subject-row">
      {#if showType}
        <MessageTypeBadge type={message.type} />
      {/if}
      <span class="subject" class:subject--unread={!message.isRead}>
        {message.subject || '(no subject)'}
      </span>
    </div>

    {#if !compact}
      <div class="preview-row">
        {#if typeContent}
          {@render typeContent({ message })}
        {:else if _tweetMeta}
          <span class="meta-inline">
            🔄 {_tweetMeta.retweetCount}
            ❤ {_tweetMeta.likeCount}
            💬 {_tweetMeta.replyCount}
          </span>
        {:else if _slackMeta && _slackMeta.channelName}
          <span class="meta-inline">
            #{_slackMeta.channelName}
          </span>
        {:else if _emailMeta?.folderPath}
          <span class="meta-inline">{_emailMeta.folderPath}</span>
        {/if}
        <span class="preview">{_preview}</span>
      </div>
    {/if}
  </button>

  {#if onflag}
    <button
      class="flag-btn"
      type="button"
      onclick={() => onflag?.(message)}
      title={message.isFlagged ? 'Unflag' : 'Flag'}
      aria-label={message.isFlagged ? 'Unflag' : 'Flag'}
    >
      {message.isFlagged ? '⚑' : '⚐'}
    </button>
  {/if}
</div>

<style>
  .message-card {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .message-card:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .message-card--selected {
    background: var(--smrt-color-secondary-container, #d7e3f7);
  }

  .message-card--unread {
    background: var(--smrt-color-surface, #fefbff);
  }

  .select-col {
    display: flex;
    align-items: center;
    padding: 0.75rem 0.5rem 0.75rem 0.75rem;
  }

  .message-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 0.75rem 0.75rem 0.5rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    min-width: 0;
    color: inherit;
    font: inherit;
  }

  .message-content:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }

  .sender {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .sender-name {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sender-name--unread {
    font-weight: 600;
  }

  .account-label {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface-variant, #e1e2ec);
    padding: 0.125rem 0.375rem;
    border-radius: var(--smrt-radius-small, 0.25rem);
    white-space: nowrap;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .date {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
  }

  .subject-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }

  .subject {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subject--unread {
    font-weight: 600;
  }

  .preview-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .preview {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta-inline {
    flex-shrink: 0;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .flag-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 1rem;
    color: var(--smrt-color-on-surface-variant, #43474e);
    opacity: 0.5;
    transition: opacity var(--smrt-duration-short2, 150ms);
  }

  .flag-btn:hover {
    opacity: 1;
  }

  .message-card--compact .message-content {
    padding: 0.5rem 0.75rem 0.5rem 0.5rem;
  }

  .message-card--compact .preview-row {
    display: none;
  }
</style>
