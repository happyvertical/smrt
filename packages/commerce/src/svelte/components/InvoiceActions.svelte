<script lang="ts">
/**
 * InvoiceActions - Status-based action buttons for invoices
 *
 * Renders appropriate action buttons based on invoice status.
 */

import type { InvoiceStatus } from '../types.js';

interface Props {
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

<div class="invoice-actions" class:sm={size === 'sm'}>
  {#if canSend && onsend}
    <button type="button" class="btn btn-primary" onclick={onsend} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M14 2L7 9M14 2l-4 12-3-5-5-3 12-4z" />
      </svg>
      Send Invoice
    </button>
  {/if}

  {#if canMarkPaid && onmarkpaid}
    <button type="button" class="btn btn-success" onclick={onmarkpaid} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 8l4 4 6-8" />
      </svg>
      Mark as Paid
    </button>
  {/if}

  {#if canEdit && onedit}
    <button type="button" class="btn btn-secondary" onclick={onedit} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z" />
      </svg>
      Edit
    </button>
  {/if}

  {#if onprint}
    <button type="button" class="btn btn-secondary" onclick={onprint} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 5V2h8v3M4 11h8M2 5h12v6H2z" />
        <path d="M4 11v3h8v-3" />
      </svg>
      Print
    </button>
  {/if}

  {#if onexport}
    <button type="button" class="btn btn-secondary" onclick={onexport} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M8 2v8M4 6l4-4 4 4M2 12v2h12v-2" />
      </svg>
      Export
    </button>
  {/if}

  {#if canDelete && ondelete}
    <button type="button" class="btn btn-danger" onclick={ondelete} disabled={loading}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 4h10M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1M6 7v5M10 7v5" />
        <path d="M4 4l1 10h6l1-10" />
      </svg>
      Delete
    </button>
  {/if}
</div>

<style>
  .invoice-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .sm .btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #3b82f6;
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-success {
    background: #16a34a;
    color: white;
  }

  .btn-success:hover:not(:disabled) {
    background: #15803d;
  }

  .btn-secondary {
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #f9fafb;
    border-color: #9ca3af;
  }

  .btn-danger {
    background: white;
    color: #dc2626;
    border: 1px solid #fecaca;
  }

  .btn-danger:hover:not(:disabled) {
    background: #fee2e2;
    border-color: #fca5a5;
  }
</style>
