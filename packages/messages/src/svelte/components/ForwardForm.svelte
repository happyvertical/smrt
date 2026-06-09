<script lang="ts" module>
import type { MessageData, RecipientEntry } from '../types.js';

export interface Props {
  originalMessage: MessageData;
  onsend?: (to: RecipientEntry[], body: string) => void;
  oncancel?: () => void;
}
</script>

<script lang="ts">
  import RecipientInput from './RecipientInput.svelte';

  let { originalMessage, onsend, oncancel }: Props = $props();

  let to: RecipientEntry[] = $state([]);
  let body = $state('');
  let isSending = $state(false);

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

  function handleSend() {
    if (isSending || to.length === 0) return;
    isSending = true;
    onsend?.(to, body);
  }
</script>

<div class="forward-form">
  <div class="forward-header">Forward message</div>

  <RecipientInput
    label="To"
    recipients={to}
    onchange={(r) => { to = r; }}
  />

  <textarea
    class="forward-body"
    bind:value={body}
    placeholder="Add a note (optional)..."
    rows={3}
  ></textarea>

  <div class="forwarded-original">
    <pre class="forwarded-text">{forwardedBlock}</pre>
  </div>

  <div class="actions">
    <button
      type="button"
      class="btn-primary"
      disabled={isSending || to.length === 0}
      onclick={handleSend}
    >
      {isSending ? 'Sending...' : 'Forward'}
    </button>
    <button type="button" class="btn-text" onclick={() => oncancel?.()}>
      Cancel
    </button>
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

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
  }

  .btn-primary {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-6, 24px);
    border-radius: var(--smrt-radius-full, 20px);
    border: none;
    background: var(--smrt-color-primary, #6750a4);
    color: var(--smrt-color-on-primary, #fff);
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-label-large-size, 14px);
    cursor: pointer;
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-text {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-4, 16px);
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #49454f);
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-label-large-size, 14px);
    cursor: pointer;
  }
</style>
