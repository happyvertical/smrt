<script lang="ts" module>
import type { MessageData, RecipientEntry } from '../types.js';

export interface Props {
  originalMessage: MessageData;
  onsend?: (to: RecipientEntry[], body: string) => void;
  oncancel?: () => void;
}
</script>

<script lang="ts">
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { M } from '../i18n.js';
  import RecipientInput from './RecipientInput.svelte';

  const { t } = useI18n();

  let { originalMessage, onsend, oncancel }: Props = $props();

  let to: RecipientEntry[] = $state([]);
  let body = $state('');
  let isSending = $state(false);
  let sendError = $state<string | null>(null);

  const forwardedBlock = $derived.by(() => {
    const dateStr = originalMessage.date
      ? new Date(originalMessage.date).toLocaleString()
      : 'unknown date';
    const from = originalMessage.senderName || originalMessage.senderAddress;
    const toStr = originalMessage.recipientAddresses
      ?.map((r) => (r.name ? `${r.name} <${r.address}>` : r.address))
      .join(', ') || '';

    return [
      '---------- Forwarded message ----------',
      `From: ${from}`,
      `Date: ${dateStr}`,
      `Subject: ${originalMessage.subject}`,
      `To: ${toStr}`,
      '',
      originalMessage.body || '',
    ].join('\n');
  });

  async function handleSend() {
    if (isSending || to.length === 0) return;
    isSending = true;
    sendError = null;
    try {
      // onsend may be sync or async; awaiting handles both so the button never
      // latches in the "Sending…" state on failure.
      await onsend?.(to, body);
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    } finally {
      isSending = false;
    }
  }
</script>

<div class="forward-form">
  <div class="forward-header">{t(M['messages.forward_form.header'])}</div>

  <RecipientInput
    label="To"
    recipients={to}
    onchange={(r) => { to = r; }}
  />

  <textarea
    class="forward-body"
    bind:value={body}
    placeholder={t(M['messages.forward_form.note_placeholder'])}
    rows={3}
  ></textarea>

  <div class="forwarded-original">
    <pre class="forwarded-text">{forwardedBlock}</pre>
  </div>

  {#if sendError}
    <div class="send-error" role="alert" aria-live="assertive">
      {sendError}
    </div>
  {/if}

  <div class="actions">
    <Button
      variant="primary"
      disabled={isSending || to.length === 0}
      onclick={handleSend}
    >
      {isSending ? 'Sending...' : 'Forward'}
    </Button>
    <Button variant="ghost" class="btn-text" onclick={() => oncancel?.()}>
      Cancel
    </Button>
  </div>
</div>

<style>
  .forward-form {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-3, 12px);
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-md, 12px);
    background: var(--smrt-color-surface, #fffbfe);
    font-family: var(--smrt-font-family, system-ui);
  }

  .forward-header {
    font-size: var(--smrt-typography-title-small-size, 13px);
    color: var(--smrt-color-on-surface-variant, #49454f);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .forward-body {
    width: 100%;
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-sm, 8px);
    padding: var(--smrt-spacing-2, 8px);
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-body-medium-size, 14px);
    resize: vertical;
    box-sizing: border-box;
  }

  .forward-body:focus {
    outline: 2px solid var(--smrt-color-primary, #6750a4);
    outline-offset: -1px;
  }

  .forwarded-original {
    padding: var(--smrt-spacing-2, 8px);
    background: var(--smrt-color-surface-variant, #e7e0ec);
    border-radius: var(--smrt-radius-sm, 8px);
    max-height: 300px;
    overflow-y: auto;
  }

  .forwarded-text {
    margin: 0;
    font-size: var(--smrt-typography-body-small-size, 12px);
    color: var(--smrt-color-on-surface-variant, #49454f);
    white-space: pre-wrap;
    font-family: var(--smrt-font-family, system-ui);
  }

  .send-error {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-sm, 8px);
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
    font-size: var(--smrt-typography-body-small-size, 12px);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
  }

  /*
   * Forward now uses Button's primary variant directly (dead .btn-primary CSS
   * removed). The Cancel button keeps its neutral on-surface-variant text via
   * `.actions :global(.btn-text)` (Button's ghost uses the primary color) —
   * issue #1589.
   */
  .actions :global(.btn-text) {
    color: var(--smrt-color-on-surface-variant, #49454f);
  }
</style>
