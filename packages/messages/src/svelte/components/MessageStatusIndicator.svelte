<script lang="ts">
/**
 * MessageStatusIndicator - Read/flag/attachment indicators
 */

export interface Props {
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  isAnswered?: boolean;
  isDraft?: boolean;
}

const {
  isRead,
  isFlagged,
  hasAttachments,
  isAnswered = false,
  isDraft = false,
}: Props = $props();
</script>

<span class="status-indicators" role="group" aria-label="Message status">
  {#if !isRead}
    <span class="indicator unread" title="Unread" aria-label="Unread">
      <span class="dot"></span>
    </span>
  {/if}
  {#if isFlagged}
    <span class="indicator flagged" title="Flagged" aria-label="Flagged">⚑</span>
  {/if}
  {#if hasAttachments}
    <span class="indicator attachment" title="Has attachments" aria-label="Has attachments">📎</span>
  {/if}
  {#if isAnswered}
    <span class="indicator answered" title="Replied" aria-label="Replied">↩</span>
  {/if}
  {#if isDraft}
    <span class="indicator draft" title="Draft" aria-label="Draft">✎</span>
  {/if}
</span>

<style>
  .status-indicators {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
  }

  .indicator {
    display: inline-flex;
    align-items: center;
  }

  .unread .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--smrt-color-primary, #005ac1);
  }

  .flagged {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .attachment {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .answered {
    color: var(--smrt-color-primary, #005ac1);
  }

  .draft {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }
</style>
