<script lang="ts" module>
import type { MessageData } from '../types.js';

export interface Props {
  /** Message to reply to, shown as quoted text. */
  originalMessage: MessageData;
  /** Reply to all recipients when true; reply to sender only when false. */
  replyAll?: boolean;
  /** Called when user sends the reply. */
  onsend?: (body: string) => void;
  /** Called when user cancels the reply. */
  oncancel?: () => void;
}
</script>

<script lang="ts">
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Textarea } from '@happyvertical/smrt-ui/forms';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { M } from '../i18n.js';

  const { t } = useI18n();

  let {
    originalMessage,
    replyAll = false,
    onsend,
    oncancel,
  }: Props = $props();

  let body = $state('');
  let isSending = $state(false);
  let sendError = $state<string | null>(null);

  const quotedBody = $derived.by(() => {
    const dateStr = originalMessage.date
      ? new Date(originalMessage.date).toLocaleString()
      : 'unknown date';
    const from = originalMessage.senderName || originalMessage.senderAddress;
    const lines = (originalMessage.body || '')
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    return `On ${dateStr}, ${from} wrote:\n${lines}`;
  });

  async function handleSend() {
    if (isSending) return;
    isSending = true;
    sendError = null;
    try {
      // onsend may be sync or async; awaiting handles both so the button never
      // latches in the "Sending…" state on failure.
      await onsend?.(body);
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    } finally {
      isSending = false;
    }
  }
</script>

<div class="reply-form" data-smrt-component="ReplyForm">
  <div class="reply-header">
    {replyAll ? 'Reply All' : 'Reply'} to {originalMessage.senderName || originalMessage.senderAddress}
  </div>

  <Textarea
    bind:value={body}
    placeholder={t(M['messages.reply_form.body_placeholder'])}
    rows={5}
  />

  <div class="quoted-original">
    <pre class="quoted-text">{quotedBody}</pre>
  </div>

  {#if sendError}
    <div class="send-error" role="alert" aria-live="assertive">
      {sendError}
    </div>
  {/if}

  <div class="actions">
    <Button
      variant="primary"
      disabled={isSending || !body.trim()}
      onclick={handleSend}
    >
      {isSending ? 'Sending...' : 'Send Reply'}
    </Button>
    <Button variant="ghost" class="btn-text" onclick={() => oncancel?.()}>
      Cancel
    </Button>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .reply-form {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-3);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
    background: var(--smrt-color-surface);
    font-family: var(--smrt-font-family, system-ui);
  }

  .reply-header {
    font-size: var(--smrt-typography-title-small-size);
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .quoted-original {
    padding: var(--smrt-spacing-2);
    border-left: 3px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-variant);
    border-radius: 0 var(--smrt-radius-sm) var(--smrt-radius-sm) 0;
    max-height: 200px;
    overflow-y: auto;
  }

  .quoted-text {
    margin: 0;
    font-size: var(--smrt-typography-body-small-size);
    color: var(--smrt-color-on-surface-variant);
    white-space: pre-wrap;
    font-family: var(--smrt-font-family, system-ui);
  }

  .send-error {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
    font-size: var(--smrt-typography-body-small-size);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  /*
   * Send Reply now uses Button's primary variant directly (dead .btn-primary CSS
   * removed). The Cancel button keeps its neutral on-surface-variant text via
   * `.actions :global(.btn-text)` (Button's ghost uses the primary color) —
   * issue #1589.
   */
  .actions :global(.btn-text) {
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
