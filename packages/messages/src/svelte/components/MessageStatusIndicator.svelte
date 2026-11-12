<script lang="ts">
/**
 * MessageStatusIndicator - Read/flag/attachment indicators
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.messages.js';

const { t } = useI18n();

export interface Props {
  /** Shows unread indicator dot when false. */
  isRead: boolean;
  /** Shows flag icon when true. */
  isFlagged: boolean;
  /** Shows attachment icon when true. */
  hasAttachments: boolean;
  /** Shows reply icon when the message has been answered. */
  isAnswered?: boolean;
  /** Shows draft indicator when message has not been sent. */
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

<span class="smrt-message-status-indicator__root" role="group" aria-label={t(M['messages.message_status_indicator.status'])} data-smrt-component="MessageStatusIndicator">
  {#if !isRead}
    <span class="smrt-message-status-indicator__indicator smrt-message-status-indicator__unread" data-smrt-part="indicator" title={t(M['messages.message_status_indicator.unread'])} aria-label={t(M['messages.message_status_indicator.unread'])}>
      <span class="smrt-message-status-indicator__marker" data-smrt-part="marker"></span>
    </span>
  {/if}
  {#if isFlagged}
    <span class="smrt-message-status-indicator__indicator smrt-message-status-indicator__flagged" data-smrt-part="indicator" title={t(M['messages.message_status_indicator.flagged'])} aria-label={t(M['messages.message_status_indicator.flagged'])}>⚑</span>
  {/if}
  {#if hasAttachments}
    <span class="smrt-message-status-indicator__indicator smrt-message-status-indicator__attachment" data-smrt-part="indicator" title={t(M['messages.message_status_indicator.has_attachments'])} aria-label={t(M['messages.message_status_indicator.has_attachments'])}>📎</span>
  {/if}
  {#if isAnswered}
    <span class="smrt-message-status-indicator__indicator smrt-message-status-indicator__answered" data-smrt-part="indicator" title={t(M['messages.message_status_indicator.replied'])} aria-label={t(M['messages.message_status_indicator.replied'])}>↩</span>
  {/if}
  {#if isDraft}
    <span class="smrt-message-status-indicator__indicator smrt-message-status-indicator__draft" data-smrt-part="indicator" title={t(M['messages.message_status_indicator.draft'])} aria-label={t(M['messages.message_status_indicator.draft'])}>✎</span>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-message-status-indicator__root {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .smrt-message-status-indicator__indicator {
    display: inline-flex;
    align-items: center;
  }
  .smrt-message-status-indicator__unread .smrt-message-status-indicator__marker {
    width: 0.5rem;
    height: 0.5rem;
  }
}

@layer smrt.theme {
  .smrt-message-status-indicator__root {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  .smrt-message-status-indicator__unread .smrt-message-status-indicator__marker {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
  }
  .smrt-message-status-indicator__flagged {
    color: var(--smrt-color-error);
  }
  .smrt-message-status-indicator__attachment {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-message-status-indicator__answered {
    color: var(--smrt-color-primary);
  }
  .smrt-message-status-indicator__draft {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
