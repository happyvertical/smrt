<script lang="ts">
/**
 * MessageStatusIndicator - Read/flag/attachment indicators
 */
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { M } from '../i18n.messages.js';

const { t } = useI18n();

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

<span class="status-indicators" role="group" aria-label={t(M['messages.message_status_indicator.status'])}>
  {#if !isRead}
    <span class="indicator unread" title={t(M['messages.message_status_indicator.unread'])} aria-label={t(M['messages.message_status_indicator.unread'])}>
      <span class="dot"></span>
    </span>
  {/if}
  {#if isFlagged}
    <span class="indicator flagged" title={t(M['messages.message_status_indicator.flagged'])} aria-label={t(M['messages.message_status_indicator.flagged'])}>⚑</span>
  {/if}
  {#if hasAttachments}
    <span class="indicator attachment" title={t(M['messages.message_status_indicator.has_attachments'])} aria-label={t(M['messages.message_status_indicator.has_attachments'])}>📎</span>
  {/if}
  {#if isAnswered}
    <span class="indicator answered" title={t(M['messages.message_status_indicator.replied'])} aria-label={t(M['messages.message_status_indicator.replied'])}>↩</span>
  {/if}
  {#if isDraft}
    <span class="indicator draft" title={t(M['messages.message_status_indicator.draft'])} aria-label={t(M['messages.message_status_indicator.draft'])}>✎</span>
  {/if}
</span>

<style>
  .status-indicators {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  .indicator {
    display: inline-flex;
    align-items: center;
  }

  .unread .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
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
