<script lang="ts" module>
import type { MessageData } from '../types.js';

export interface Props {
  originalMessage: MessageData;
  replyAll?: boolean;
  onsend?: (body: string) => void;
  oncancel?: () => void;
}
</script>

<script lang="ts">
  let {
    originalMessage,
    replyAll = false,
    onsend,
    oncancel,
  }: Props = $props();

  let body = $state('');
  let isSending = $state(false);

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

  function handleSend() {
    if (isSending) return;
    isSending = true;
    onsend?.(body);
  }
</script>

<div class="reply-form">
  <div class="reply-header">
    {replyAll ? 'Reply All' : 'Reply'} to {originalMessage.senderName || originalMessage.senderAddress}
  </div>

  <textarea
    class="reply-body"
    bind:value={body}
    placeholder="Write your reply..."
    rows={5}
  ></textarea>

  <div class="quoted-original">
    <pre class="quoted-text">{quotedBody}</pre>
  </div>

  <div class="actions">
    <button
      type="button"
      class="btn-primary"
      disabled={isSending || !body.trim()}
      onclick={handleSend}
    >
      {isSending ? 'Sending...' : 'Send Reply'}
    </button>
    <button type="button" class="btn-text" onclick={() => oncancel?.()}>
      Cancel
    </button>
  </div>
</div>

<style>
  .reply-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-md, 12px);
    background: var(--smrt-color-surface, #fffbfe);
    font-family: var(--smrt-typography-body, system-ui);
  }

  .reply-header {
    font-size: 13px;
    color: var(--smrt-color-on-surface-variant, #49454f);
    font-weight: 500;
  }

  .reply-body {
    width: 100%;
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-sm, 8px);
    padding: 8px;
    font-family: var(--smrt-typography-body, system-ui);
    font-size: 14px;
    resize: vertical;
    box-sizing: border-box;
  }

  .reply-body:focus {
    outline: 2px solid var(--smrt-color-primary, #6750a4);
    outline-offset: -1px;
  }

  .quoted-original {
    padding: 8px;
    border-left: 3px solid var(--smrt-color-outline-variant, #cac4d0);
    background: var(--smrt-color-surface-variant, #e7e0ec);
    border-radius: 0 var(--smrt-radius-sm, 8px) var(--smrt-radius-sm, 8px) 0;
    max-height: 200px;
    overflow-y: auto;
  }

  .quoted-text {
    margin: 0;
    font-size: 12px;
    color: var(--smrt-color-on-surface-variant, #49454f);
    white-space: pre-wrap;
    font-family: var(--smrt-typography-body, system-ui);
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .btn-primary {
    padding: 8px 24px;
    border-radius: var(--smrt-radius-full, 20px);
    border: none;
    background: var(--smrt-color-primary, #6750a4);
    color: var(--smrt-color-on-primary, #fff);
    font-family: var(--smrt-typography-label, system-ui);
    font-size: 14px;
    cursor: pointer;
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-text {
    padding: 8px 16px;
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #49454f);
    font-family: var(--smrt-typography-label, system-ui);
    font-size: 14px;
    cursor: pointer;
  }
</style>
