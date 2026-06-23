<script lang="ts">
/**
 * InvoiceActions - Status-based action buttons for invoices
 *
 * Renders appropriate action buttons based on invoice status.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { InvoiceStatus } from '../types.js';

const { t } = useI18n();

/** Props for InvoiceActions component */
export interface Props {
  /** Current invoice status */
  status: InvoiceStatus;
  /** Loading state */
  loading?: boolean;
  /** Called when send is clicked */
  onsend?: () => void;
  /** Called when mark paid is clicked */
  onmarkpaid?: () => void;
  /** Called when edit is clicked */
  onedit?: () => void;
  /** Called when delete is clicked */
  ondelete?: () => void;
  /** Called when print is clicked */
  onprint?: () => void;
  /** Called when export/download is clicked */
  onexport?: () => void;
  /** Size variant */
  size?: 'sm' | 'md';
}

const {
  status,
  loading = false,
  onsend,
  onmarkpaid,
  onedit,
  ondelete,
  onprint,
  onexport,
  size = 'md',
}: Props = $props();

// Determine which actions to show based on status
const canEdit = $derived(status === 'draft');
const canSend = $derived(status === 'draft');
const canMarkPaid = $derived(
  status === 'sent' || status === 'viewed' || status === 'overdue',
);
const canDelete = $derived(status === 'draft');
</script>

<div class="invoice-actions">
  {#if canSend && onsend}
    <Button variant="primary" {size} onclick={onsend} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2L7 9M14 2l-4 12-3-5-5-3 12-4z" />
      </svg>
      {t(M['commerce.invoice_actions.send_invoice'])}
    </Button>
  {/if}

  {#if canMarkPaid && onmarkpaid}
    <Button variant="primary" {size} onclick={onmarkpaid} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 8l4 4 6-8" />
      </svg>
      {t(M['commerce.invoice_actions.mark_as_paid'])}
    </Button>
  {/if}

  {#if canEdit && onedit}
    <Button variant="secondary" {size} onclick={onedit} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
      </svg>
      Edit
    </Button>
  {/if}

  {#if onprint}
    <Button variant="secondary" {size} onclick={onprint} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 5V2h8v3M4 11h8M2 5h12v6H2z" />
        <path d="M4 11v3h8v-3" />
      </svg>
      Print
    </Button>
  {/if}

  {#if onexport}
    <Button variant="secondary" {size} onclick={onexport} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M8 2v8M4 6l4-4 4 4M2 12v2h12v-2" />
      </svg>
      Export
    </Button>
  {/if}

  {#if canDelete && ondelete}
    <Button variant="danger" {size} onclick={ondelete} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v5M10 7v5" />
        <path d="M4 4l1 10h6l1-10" />
      </svg>
      Delete
    </Button>
  {/if}
</div>

<style>
  .invoice-actions {
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
    flex-wrap: wrap;
  }
</style>
