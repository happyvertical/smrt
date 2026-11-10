<script lang="ts">
/**
 * MessageDetail - Full message view with type-adaptive sections
 */

import { Button, Card } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import type { AccountData, AttachmentData, MessageData } from '../types.js';
import AttachmentChip from './AttachmentChip.svelte';
import MessageStatusIndicator from './MessageStatusIndicator.svelte';
import MessageTypeBadge from './MessageTypeBadge.svelte';

export interface Props {
  /** Message to display in full detail view. */
  message: MessageData;
  /** Attachments associated with the message. */
  attachments?: AttachmentData[];
  /** Account that received the message. */
  account?: AccountData;
  /** Reads the body from the HTML source, stripped of tags and shown as text. */
  showHtml?: boolean;
  /** Called when user clicks the reply button. */
  onreply?: (message: MessageData) => void;
  /** Called when user clicks the forward button. */
  onforward?: (message: MessageData) => void;
  /** Called when user clicks the delete button. */
  ondelete?: (message: MessageData) => void;
  /** Custom snippet to render type-specific details. */
  typeDetail?: Snippet<[{ message: MessageData }]>;
}

const {
  message,
  attachments = [],
  account,
  showHtml = false,
  onreply,
  onforward,
  ondelete,
  typeDetail,
}: Props = $props();

const _formattedDate = $derived.by(() => {
  if (!message.date) return '';
  const d =
    typeof message.date === 'string' ? new Date(message.date) : message.date;
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
});

const _recipients = $derived.by(() => {
  return message.recipientAddresses
    .map((r) => (r.name ? `${r.name} <${r.address}>` : r.address))
    .join(', ');
});

const _ccRecipients = $derived.by(() => {
  if (!message.ccAddresses || message.ccAddresses.length === 0) return '';
  return message.ccAddresses
    .map((r) => (r.name ? `${r.name} <${r.address}>` : r.address))
    .join(', ');
});

const _tweetMeta = $derived.by(() => {
  if (message.type !== 'tweet') return null;
  return message.meta || {};
});

const _slackMeta = $derived.by(() => {
  if (message.type !== 'slack') return null;
  return message.meta || {};
});

// Body is always rendered as untrusted plain text — we never inject provider
// HTML via {@html}. A regex "sanitizer" is bypassable (e.g. an unclosed
// <script> survives), so when the caller opts into the HTML body we down-render
// it to text by stripping tags. Real rich-HTML rendering, if ever needed, must
// go through a vetted sanitizer or a sandboxed iframe (out of scope here).
const _displayBody = $derived.by(() => {
  if (showHtml && message.htmlBody) {
    return message.htmlBody.replace(/<[^>]*>/g, '');
  }
  return message.body;
});
</script>

<article class="smrt-message-detail__root" data-smrt-component="MessageDetail">
  <Card padding="lg">
    <header class="smrt-message-detail__header" data-smrt-part="header">
      <div class="smrt-message-detail__status" data-smrt-part="status">
        <MessageTypeBadge type={message.type} size="md" />
        <MessageStatusIndicator
          isRead={message.isRead}
          isFlagged={message.isFlagged}
          hasAttachments={message.hasAttachments}
        />
      </div>

      <h2 class="smrt-message-detail__subject" data-smrt-part="title">{message.subject || '(no subject)'}</h2>

      <div class="smrt-message-detail__meta" data-smrt-part="meta">
        <div class="smrt-message-detail__meta-row" data-smrt-part="row">
          <span class="smrt-message-detail__meta-label" data-smrt-part="label">From</span>
          <span class="smrt-message-detail__meta-value" data-smrt-part="value">
            {message.senderName ? `${message.senderName} <${message.senderAddress}>` : message.senderAddress}
          </span>
        </div>
        <div class="smrt-message-detail__meta-row" data-smrt-part="row">
          <span class="smrt-message-detail__meta-label" data-smrt-part="label">To</span>
          <span class="smrt-message-detail__meta-value" data-smrt-part="value">{_recipients}</span>
        </div>
        {#if _ccRecipients}
          <div class="smrt-message-detail__meta-row" data-smrt-part="row">
            <span class="smrt-message-detail__meta-label" data-smrt-part="label">Cc</span>
            <span class="smrt-message-detail__meta-value" data-smrt-part="value">{_ccRecipients}</span>
          </div>
        {/if}
        <div class="smrt-message-detail__meta-row" data-smrt-part="row">
          <span class="smrt-message-detail__meta-label" data-smrt-part="label">Date</span>
          <time class="smrt-message-detail__meta-value" data-smrt-part="value">{_formattedDate}</time>
        </div>
        {#if account}
          <div class="smrt-message-detail__meta-row" data-smrt-part="row">
            <span class="smrt-message-detail__meta-label" data-smrt-part="label">Account</span>
            <span class="smrt-message-detail__meta-value" data-smrt-part="value">{account.name}</span>
          </div>
        {/if}
      </div>
    </header>

    {#if typeDetail}
      <div class="smrt-message-detail__type-detail" data-smrt-part="body">
        {@render typeDetail({ message })}
      </div>
    {:else if _tweetMeta}
      <div class="smrt-message-detail__type-specific" data-smrt-part="group">
        <span>🔄 {_tweetMeta.retweetCount || 0}</span>
        <span>❤ {_tweetMeta.likeCount || 0}</span>
        <span>💬 {_tweetMeta.replyCount || 0}</span>
      </div>
    {:else if _slackMeta}
      <div class="smrt-message-detail__type-specific" data-smrt-part="group">
        {#if _slackMeta.channelName}
          <span>#{_slackMeta.channelName}</span>
        {/if}
      </div>
    {/if}

    <div class="smrt-message-detail__body" data-smrt-part="body">
      <pre class="smrt-message-detail__body-text" data-smrt-part="message">{_displayBody}</pre>
    </div>

    {#if attachments.length > 0}
      <div class="smrt-message-detail__attachments" data-smrt-part="group">
        <h3 class="smrt-message-detail__attachments-label" data-smrt-part="title">Attachments ({attachments.length})</h3>
        <div class="smrt-message-detail__attachments-list" data-smrt-part="list">
          {#each attachments as attachment (attachment.id)}
            <AttachmentChip {attachment} />
          {/each}
        </div>
      </div>
    {/if}

    {#if onreply || onforward || ondelete}
      <div class="smrt-message-detail__actions" data-smrt-part="actions">
        {#if onreply}
          <Button variant="ghost" class="action-btn" onclick={() => onreply?.(message)}>
            ↩ Reply
          </Button>
        {/if}
        {#if onforward}
          <Button variant="ghost" class="action-btn" onclick={() => onforward?.(message)}>
            ↪ Forward
          </Button>
        {/if}
        {#if ondelete}
          <Button variant="ghost" class="action-btn action-btn--danger" onclick={() => ondelete?.(message)}>
            🗑 Delete
          </Button>
        {/if}
      </div>
    {/if}
  </Card>
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-detail__root {
    max-width: 100%;
  }
  .smrt-message-detail__header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-bottom: 1rem;
  }
  .smrt-message-detail__status {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .smrt-message-detail__subject {
    margin: 0;
  }
  .smrt-message-detail__meta {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-message-detail__meta-row {
    display: flex;
    gap: 0.75rem;
  }
  .smrt-message-detail__meta-label {
    flex-shrink: 0;
    width: 4rem;
  }
  .smrt-message-detail__meta-value {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-message-detail__type-specific {
    display: flex;
    gap: 1rem;
    padding: 0.75rem 0;
  }
  .smrt-message-detail__type-detail {
    padding: 0.75rem 0;
  }
  .smrt-message-detail__body {
    padding: 1rem 0;
  }
  .smrt-message-detail__body-text {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .smrt-message-detail__attachments {
    padding-top: 0.75rem;
  }
  .smrt-message-detail__attachments-label {
    margin: 0 0 0.5rem;
  }
  .smrt-message-detail__attachments-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .smrt-message-detail__actions {
    display: flex;
    gap: 0.5rem;
    padding-top: 1rem;
  }
  /*
  * Action buttons now render through smrt-ui's <Button variant="ghost">. The
  * <button> is emitted inside the Button child, so `.smrt-message-detail__actions :global(.action-btn)`
  * anchors on the real `.smrt-message-detail__actions` element and pierces the child scope to keep
  * the original outlined-surface styling (issue #1589). The destructive button's
  * modifier is `action-btn--danger`, NOT `danger`, to avoid colliding with
  * Button's own `.danger` variant class.
  */
  .smrt-message-detail__actions :global(.action-btn) {
    padding: 0.5rem 1rem;
  }
}

@layer smrt.theme {
  .smrt-message-detail__header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-message-detail__subject {
    font: var(--smrt-typography-title-large-font, 600 1.375rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-message-detail__meta-row {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
  }
  .smrt-message-detail__meta-label {
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-message-detail__meta-value {
    color: var(--smrt-color-on-surface);
  }
  .smrt-message-detail__type-specific {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-detail__body-text {
    font: var(--smrt-typography-body-large-font, 1rem / 1.5 sans-serif);
    color: var(--smrt-color-on-surface);
    font-family: inherit;
  }
  .smrt-message-detail__attachments {
    border-top: var(--smrt-hairline);
  }
  .smrt-message-detail__attachments-label {
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-detail__actions {
    border-top: var(--smrt-hairline);
  }
  /*
  * Action buttons now render through smrt-ui's <Button variant="ghost">. The
  * <button> is emitted inside the Button child, so `.smrt-message-detail__actions :global(.action-btn)`
  * anchors on the real `.smrt-message-detail__actions` element and pierces the child scope to keep
  * the original outlined-surface styling (issue #1589). The destructive button's
  * modifier is `action-btn--danger`, NOT `danger`, to avoid colliding with
  * Button's own `.danger` variant class.
  */
  .smrt-message-detail__actions :global(.action-btn) {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-message-detail__actions :global(.action-btn):hover {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-message-detail__actions :global(.action-btn--danger) {
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }
  .smrt-message-detail__actions :global(.action-btn--danger):hover {
    background: var(--smrt-color-error-container);
  }
}

</style>
