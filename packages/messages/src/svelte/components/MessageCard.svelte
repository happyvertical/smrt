<script lang="ts">
/**
 * MessageCard - Single message row with type-adaptive rendering
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../i18n.messages.js';
import type { AccountData, MessageData } from '../types.js';
import MessageStatusIndicator from './MessageStatusIndicator.svelte';
import MessageTypeBadge from './MessageTypeBadge.svelte';

const { t } = useI18n();

export interface Props {
  /** Message data to render as a list row. */
  message: MessageData;
  /** Highlights the row to show it is currently selected. */
  selected?: boolean;
  /** Uses condensed layout to fit more messages on screen. */
  compact?: boolean;
  /** Shows the sender's account information on the row. */
  showAccount?: boolean;
  /** Shows the message type badge (email, Slack, etc.). */
  showType?: boolean;
  /** Called when user clicks on the message row. */
  onclick?: (message: MessageData) => void;
  /** Called when user selects the message with checkbox. */
  onselect?: (message: MessageData) => void;
  /** Called when the user flags or unflags the message. */
  onflag?: (message: MessageData) => void;
  /** Account data for display if showAccount is true. */
  account?: AccountData;
  /** Custom snippet to render type-specific content. */
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
  class="smrt-message-card__root"
  class:smrt-message-card__selected={selected}
  class:smrt-message-card__unread={!message.isRead}
  class:smrt-message-card__compact={compact}
  role="row"
  aria-selected={selected} data-smrt-component="MessageCard"
>
  {#if onselect}
    <div class="smrt-message-card__select" data-smrt-part="field">
      <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
      <input
        type="checkbox"
        checked={selected}
        onchange={() => onselect?.(message)}
        aria-label={t(M['messages.message_card.select_message'])}
      />
    </div>
  {/if}

  <!-- raw-primitive-allow: large pressable message row wrapping rich header/subject/preview content (a structural selection surface with descendant compact-mode layout rules), not a standard action button -->
  <button
    class="smrt-message-card__content"
    data-smrt-part="body"
    type="button"
    onclick={() => onclick?.(message)}
  >
    <div class="smrt-message-card__header" data-smrt-part="header">
      <div class="smrt-message-card__sender" data-smrt-part="author">
        <span class="smrt-message-card__name" data-smrt-part="title" class:smrt-message-card__name--unread={!message.isRead}>
          {message.senderName || message.senderAddress}
        </span>
        {#if showAccount && account}
          <span class="smrt-message-card__account" data-smrt-part="meta">{account.name}</span>
        {/if}
      </div>
      <div class="smrt-message-card__meta" data-smrt-part="meta">
        <MessageStatusIndicator
          isRead={message.isRead}
          isFlagged={message.isFlagged}
          hasAttachments={message.hasAttachments}
        />
        <time class="smrt-message-card__date" data-smrt-part="meta">{_formattedDate}</time>
      </div>
    </div>

    <div class="smrt-message-card__subject-row" data-smrt-part="title">
      {#if showType}
        <MessageTypeBadge type={message.type} />
      {/if}
      <span class="smrt-message-card__subject-text" class:smrt-message-card__subject-text--unread={!message.isRead} data-smrt-part="title">
        {message.subject || '(no subject)'}
      </span>
    </div>

    {#if !compact}
      <div class="smrt-message-card__preview" data-smrt-part="panel">
        {#if typeContent}
          {@render typeContent({ message })}
        {:else if _tweetMeta}
          <span class="smrt-message-card__meta-inline" data-smrt-part="meta">
            🔄 {_tweetMeta.retweetCount}
            ❤ {_tweetMeta.likeCount}
            💬 {_tweetMeta.replyCount}
          </span>
        {:else if _slackMeta && _slackMeta.channelName}
          <span class="smrt-message-card__meta-inline" data-smrt-part="meta">
            #{_slackMeta.channelName}
          </span>
        {:else if _emailMeta?.folderPath}
          <span class="smrt-message-card__meta-inline" data-smrt-part="meta">{_emailMeta.folderPath}</span>
        {/if}
        <span class="smrt-message-card__preview-text" data-smrt-part="message">{_preview}</span>
      </div>
    {/if}
  </button>

  {#if onflag}
    <Button
      variant="ghost"
      class="flag-btn"
      onclick={() => onflag?.(message)}
      title={message.isFlagged ? 'Unflag' : 'Flag'}
      aria-label={message.isFlagged ? 'Unflag' : 'Flag'}
    >
      {message.isFlagged ? '⚑' : '⚐'}
    </Button>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-card__root {
    display: flex;
    align-items: stretch;
  }
  .smrt-message-card__select {
    display: flex;
    align-items: center;
    padding: 0.75rem 0.5rem 0.75rem 0.75rem;
  }
  .smrt-message-card__content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 0.75rem 0.75rem 0.5rem;
    cursor: pointer;
    min-width: 0;
  }
  .smrt-message-card__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-message-card__sender {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .smrt-message-card__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-message-card__account {
    padding: 0.125rem 0.375rem;
    white-space: nowrap;
  }
  .smrt-message-card__meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .smrt-message-card__date {
    white-space: nowrap;
  }
  .smrt-message-card__subject-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
  }
  .smrt-message-card__subject-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-message-card__preview {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .smrt-message-card__preview-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-message-card__meta-inline {
    flex-shrink: 0;
  }
  /*
  * The flag toggle now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-message-card__root :global(.flag-btn)` anchors on the real `.smrt-message-card__root`
  * element and pierces the Button child scope to keep the dimmed icon-toggle
  * styling (issue #1589).
  */
  .smrt-message-card__root :global(.flag-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
  }
  .smrt-message-card__compact .smrt-message-card__content {
    padding: 0.5rem 0.75rem 0.5rem 0.5rem;
  }
  .smrt-message-card__compact .smrt-message-card__preview {
    display: none;
  }
}

@layer smrt.theme {
  .smrt-message-card__root {
    border-bottom: var(--smrt-hairline);
    transition: background var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-message-card__root:hover {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-message-card__selected {
    background: var(--smrt-color-secondary-container);
  }
  .smrt-message-card__unread {
    background: var(--smrt-color-surface);
  }
  .smrt-message-card__content {
    border: none;
    background: none;
    text-align: left;
    color: inherit;
    font: inherit;
  }
  .smrt-message-card__content:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-message-card__name {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-message-card__name--unread {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-message-card__account {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-variant);
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
  .smrt-message-card__date {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-card__subject-text {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-message-card__subject-text--unread {
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-message-card__preview-text {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-card__meta-inline {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  /*
  * The flag toggle now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-message-card__root :global(.flag-btn)` anchors on the real `.smrt-message-card__root`
  * element and pierces the Button child scope to keep the dimmed icon-toggle
  * styling (issue #1589).
  */
  .smrt-message-card__root :global(.flag-btn) {
    border: none;
    background: none;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    color: var(--smrt-color-on-surface-variant);
    opacity: 0.5;
    transition: opacity var(--smrt-duration-short2, 150ms);
  }
  .smrt-message-card__root :global(.flag-btn):hover {
    opacity: 1;
  }
}

</style>
