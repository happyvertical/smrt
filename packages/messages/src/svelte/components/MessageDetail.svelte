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
  message: MessageData;
  attachments?: AttachmentData[];
  account?: AccountData;
  showHtml?: boolean;
  onreply?: (message: MessageData) => void;
  onforward?: (message: MessageData) => void;
  ondelete?: (message: MessageData) => void;
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

<article class="message-detail">
  <Card padding="lg">
    <header class="detail-header">
      <div class="header-top">
        <MessageTypeBadge type={message.type} size="md" />
        <MessageStatusIndicator
          isRead={message.isRead}
          isFlagged={message.isFlagged}
          hasAttachments={message.hasAttachments}
        />
      </div>

      <h2 class="subject">{message.subject || '(no subject)'}</h2>

      <div class="meta-grid">
        <div class="meta-row">
          <span class="meta-label">From</span>
          <span class="meta-value">
            {message.senderName ? `${message.senderName} <${message.senderAddress}>` : message.senderAddress}
          </span>
        </div>
        <div class="meta-row">
          <span class="meta-label">To</span>
          <span class="meta-value">{_recipients}</span>
        </div>
        {#if _ccRecipients}
          <div class="meta-row">
            <span class="meta-label">Cc</span>
            <span class="meta-value">{_ccRecipients}</span>
          </div>
        {/if}
        <div class="meta-row">
          <span class="meta-label">Date</span>
          <time class="meta-value">{_formattedDate}</time>
        </div>
        {#if account}
          <div class="meta-row">
            <span class="meta-label">Account</span>
            <span class="meta-value">{account.name}</span>
          </div>
        {/if}
      </div>
    </header>

    {#if typeDetail}
      <div class="type-detail">
        {@render typeDetail({ message })}
      </div>
    {:else if _tweetMeta}
      <div class="type-specific">
        <span>🔄 {_tweetMeta.retweetCount || 0}</span>
        <span>❤ {_tweetMeta.likeCount || 0}</span>
        <span>💬 {_tweetMeta.replyCount || 0}</span>
      </div>
    {:else if _slackMeta}
      <div class="type-specific">
        {#if _slackMeta.channelName}
          <span>#{_slackMeta.channelName}</span>
        {/if}
      </div>
    {/if}

    <div class="body">
      <pre class="body-text">{_displayBody}</pre>
    </div>

    {#if attachments.length > 0}
      <div class="attachments">
        <h3 class="attachments-label">Attachments ({attachments.length})</h3>
        <div class="attachments-list">
          {#each attachments as attachment (attachment.id)}
            <AttachmentChip {attachment} />
          {/each}
        </div>
      </div>
    {/if}

    {#if onreply || onforward || ondelete}
      <div class="actions">
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
  .message-detail {
    max-width: 100%;
  }

  .detail-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .subject {
    margin: 0;
    font: var(--smrt-typography-title-large-font, 600 1.375rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .meta-grid {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .meta-row {
    display: flex;
    gap: 0.75rem;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
  }

  .meta-label {
    flex-shrink: 0;
    width: 4rem;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .meta-value {
    color: var(--smrt-color-on-surface, #1a1c1e);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .type-specific {
    display: flex;
    gap: 1rem;
    padding: 0.75rem 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .type-detail {
    padding: 0.75rem 0;
  }

  .body {
    padding: 1rem 0;
  }

  .body-text {
    font: var(--smrt-typography-body-large-font, 1rem / 1.5 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    font-family: inherit;
  }

  .attachments {
    padding-top: 0.75rem;
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .attachments-label {
    margin: 0 0 0.5rem;
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .attachments-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  /*
   * Action buttons now render through smrt-ui's <Button variant="ghost">. The
   * <button> is emitted inside the Button child, so `.actions :global(.action-btn)`
   * anchors on the real `.actions` element and pierces the child scope to keep
   * the original outlined-surface styling (issue #1589). The destructive button's
   * modifier is `action-btn--danger`, NOT `danger`, to avoid colliding with
   * Button's own `.danger` variant class.
   */
  .actions :global(.action-btn) {
    padding: 0.5rem 1rem;
    border: 1px solid var(--smrt-color-outline, #72787e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .actions :global(.action-btn):hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .actions :global(.action-btn--danger) {
    color: var(--smrt-color-error, #ba1a1a);
    border-color: var(--smrt-color-error, #ba1a1a);
  }

  .actions :global(.action-btn--danger):hover {
    background: var(--smrt-color-error-container, #ffdad6);
  }
</style>
