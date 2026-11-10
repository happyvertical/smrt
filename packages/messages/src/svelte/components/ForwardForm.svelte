<script lang="ts" module>
import type { MessageData, RecipientEntry } from '../types.js';

export interface Props {
  /** Message to forward to recipients. */
  originalMessage: MessageData;
  /** Called when user sends the forward. */
  onsend?: (to: RecipientEntry[], body: string) => void;
  /** Called when user cancels the forward. */
  oncancel?: () => void;
}
</script>

<script lang="ts">
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Textarea } from '@happyvertical/smrt-ui/forms';
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

<div class="smrt-forward-form__root" data-smrt-component="ForwardForm">
  <div class="smrt-forward-form__header" data-smrt-part="header">{t(M['messages.forward_form.header'])}</div>

  <RecipientInput
    label="To"
    recipients={to}
    onchange={(r) => { to = r; }}
  />

  <Textarea
    bind:value={body}
    placeholder={t(M['messages.forward_form.note_placeholder'])}
    rows={3}
  />

  <div class="smrt-forward-form__body" data-smrt-part="body">
    <pre class="smrt-forward-form__content" data-smrt-part="content">{forwardedBlock}</pre>
  </div>

  {#if sendError}
    <div class="smrt-forward-form__message" role="alert" aria-live="assertive">
      {sendError}
    </div>
  {/if}

  <div class="smrt-forward-form__actions" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-forward-form__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-3);
  }
  .smrt-forward-form__body {
    padding: var(--smrt-spacing-2);
    max-height: 300px;
    overflow-y: auto;
  }
  .smrt-forward-form__content {
    margin: 0;
    white-space: pre-wrap;
  }
  .smrt-forward-form__message {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  .smrt-forward-form__actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }
}

@layer smrt.theme {
  .smrt-forward-form__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
    background: var(--smrt-color-surface);
    font-family: var(--smrt-font-family, system-ui);
  }
  .smrt-forward-form__header {
    font-size: var(--smrt-typography-title-small-size);
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-forward-form__body {
    background: var(--smrt-color-surface-variant);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-forward-form__content {
    font-size: var(--smrt-typography-body-small-size);
    color: var(--smrt-color-on-surface-variant);
    font-family: var(--smrt-font-family, system-ui);
  }
  .smrt-forward-form__message {
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
    font-size: var(--smrt-typography-body-small-size);
  }
  /*
  * Forward now uses Button's primary variant directly (dead .btn-primary CSS
  * removed). The Cancel button keeps its neutral on-surface-variant text via
  * `.smrt-forward-form__actions :global(.btn-text)` (Button's ghost uses the primary color) —
  * issue #1589.
  */
  .smrt-forward-form__actions :global(.btn-text) {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
