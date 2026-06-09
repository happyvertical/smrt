<script lang="ts">
/**
 * InvoiceActions - Status-based action buttons for invoices
 *
 * Renders appropriate action buttons based on invoice status.
 */

import type { InvoiceStatus } from '../types.js';

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
    gap: var(--smrt-spacing-2, 0.5rem);
    flex-wrap: wrap;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-4, 1rem);
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border: none;
    border-radius: var(--smrt-radius-small, 0.375rem);
    cursor: pointer;
    transition: all var(--smrt-duration-short, 150ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .btn {
      transition: none;
    }
  }

  .sm .btn {
    padding: var(--smrt-spacing-1-5, 0.375rem) var(--smrt-spacing-3, 0.75rem);
    font: var(--smrt-typography-label-medium-font);
  }

  .btn:disabled {
    opacity: var(--smrt-state-disabled-opacity, 0.38);
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--smrt-color-primary-hover, #004493);
  }

  .btn-success {
    background: var(--smrt-color-tertiary, #006c4c);
    color: var(--smrt-color-on-tertiary, #ffffff);
  }

  .btn-success:hover:not(:disabled) {
    background: var(--smrt-color-tertiary-hover, #005138);
  }

  .btn-secondary {
    background: var(--smrt-color-surface-container-lowest, #ffffff);
    color: var(--smrt-color-on-surface-variant, #44474e);
    border: 1px solid var(--smrt-color-outline, #74777f);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-low, #f7f2fa);
    border-color: var(--smrt-color-on-surface-variant, #44474e);
  }

  .btn-danger {
    background: var(--smrt-color-surface-container-lowest, #ffffff);
    color: var(--smrt-color-error, #ba1a1a);
    border: 1px solid var(--smrt-color-error-container, #ffdad6);
  }

  .btn-danger:hover:not(:disabled) {
    background: var(--smrt-color-error-container, #ffdad6);
    border-color: var(--smrt-color-error, #ba1a1a);
  }
</style>
