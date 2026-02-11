<script lang="ts">
/**
 * InvoiceHeader - Invoice metadata display
 *
 * Shows invoice number, status, dates, and customer info.
 */

import type { InvoiceStatus } from './types.js';

/** Props for InvoiceHeader component */
export interface Props {
  /** Invoice number/reference */
  invoiceNumber: string;
  /** Current status */
  status: InvoiceStatus;
  /** Issue date */
  issueDate: Date | string;
  /** Due date */
  dueDate?: Date | string | null;
  /** Paid date */
  paidDate?: Date | string | null;
  /** Customer/client name */
  customerName?: string;
  /** Project name */
  projectName?: string;
  /** Allow editing */
  editable?: boolean;
  /** Called when status changes */
  onstatuschange?: (status: InvoiceStatus) => void;
}

const {
  invoiceNumber,
  status,
  issueDate,
  dueDate,
  paidDate,
  customerName,
  projectName,
  editable = false,
  onstatuschange,
}: Props = $props();

// Format date
function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

// Status display config using Material 3 color roles
const statusConfig: Record<
  InvoiceStatus,
  { label: string; bg: string; text: string }
> = {
  draft: {
    label: 'Draft',
    bg: 'var(--md-sys-color-surface-variant, #e0e2ec)',
    text: 'var(--md-sys-color-on-surface-variant, #43474e)',
  },
  sent: {
    label: 'Sent',
    bg: 'var(--md-sys-color-primary-container, #d8e2ff)',
    text: 'var(--md-sys-color-on-primary-container, #001a41)',
  },
  viewed: {
    label: 'Viewed',
    bg: 'var(--md-sys-color-secondary-container, #dbe2f9)',
    text: 'var(--md-sys-color-on-secondary-container, #151b2c)',
  },
  paid: {
    label: 'Paid',
    bg: 'var(--md-sys-color-tertiary-container, #f3daff)',
    text: 'var(--md-sys-color-on-tertiary-container, #251431)',
  },
  overdue: {
    label: 'Overdue',
    bg: 'var(--md-sys-color-error-container, #ffdad6)',
    text: 'var(--md-sys-color-on-error-container, #410002)',
  },
  cancelled: {
    label: 'Cancelled',
    bg: 'var(--md-sys-color-error-container, #ffdad6)',
    text: 'var(--md-sys-color-on-error-container, #410002)',
  },
};

const statusInfo = $derived(statusConfig[status] ?? statusConfig.draft);

// Check if overdue
const isOverdue = $derived.by(() => {
  if (status === 'paid' || status === 'cancelled') return false;
  if (!dueDate) return false;
  const due = typeof dueDate === 'string' ? new Date(dueDate) : dueDate;
  return due < new Date();
});
</script>

<div class="invoice-header">
  <div class="header-main">
    <div class="invoice-title">
      <h2 class="invoice-number">{invoiceNumber}</h2>
      <span
        class="status-badge"
        style:background-color={isOverdue && status !== 'overdue' ? statusConfig.overdue.bg : statusInfo.bg}
        style:color={isOverdue && status !== 'overdue' ? statusConfig.overdue.text : statusInfo.text}
      >
        {isOverdue && status !== 'overdue' ? 'Overdue' : statusInfo.label}
      </span>
    </div>

    {#if customerName || projectName}
      <div class="invoice-context">
        {#if customerName}
          <span class="context-item">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="8" cy="5" r="3" />
              <path d="M2 14v-1a4 4 0 014-4h4a4 4 0 014 4v1" />
            </svg>
            {customerName}
          </span>
        {/if}
        {#if projectName}
          <span class="context-item">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M2 4h12v10H2z" />
              <path d="M5 4V2h6v2" />
            </svg>
            {projectName}
          </span>
        {/if}
      </div>
    {/if}
  </div>

  <div class="header-meta">
    <div class="meta-item">
      <span class="meta-label">Issue Date</span>
      <span class="meta-value">{formatDate(issueDate)}</span>
    </div>

    {#if dueDate}
      <div class="meta-item" class:overdue={isOverdue}>
        <span class="meta-label">Due Date</span>
        <span class="meta-value">{formatDate(dueDate)}</span>
      </div>
    {/if}

    {#if paidDate && status === 'paid'}
      <div class="meta-item paid">
        <span class="meta-label">Paid Date</span>
        <span class="meta-value">{formatDate(paidDate)}</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .invoice-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--md-sys-spacing-6, 1.5rem);
    padding: var(--md-sys-spacing-6, 1.5rem);
    background: var(--md-sys-color-surface, #ffffff);
    border: 1px solid var(--md-sys-color-outline-variant, #c4c6cf);
    border-radius: var(--md-sys-shape-corner-medium, 0.5rem);
    flex-wrap: wrap;
  }

  .header-main {
    display: flex;
    flex-direction: column;
    gap: var(--md-sys-spacing-2, 0.5rem);
  }

  .invoice-title {
    display: flex;
    align-items: center;
    gap: var(--md-sys-spacing-3, 0.75rem);
  }

  .invoice-number {
    font: var(--md-sys-typescale-headline-small-font);
    font-weight: 600;
    color: var(--md-sys-color-on-surface, #1b1b1f);
    margin: 0;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    padding: var(--md-sys-spacing-1, 0.25rem) var(--md-sys-spacing-3, 0.75rem);
    font: var(--md-sys-typescale-label-small-font);
    font-weight: 500;
    border-radius: var(--md-sys-shape-corner-full, 9999px);
    text-transform: capitalize;
  }

  .invoice-context {
    display: flex;
    gap: var(--md-sys-spacing-4, 1rem);
    flex-wrap: wrap;
  }

  .context-item {
    display: inline-flex;
    align-items: center;
    gap: var(--md-sys-spacing-1-5, 0.375rem);
    font: var(--md-sys-typescale-body-medium-font);
    color: var(--md-sys-color-on-surface-variant, #43474e);
  }

  .context-item svg {
    flex-shrink: 0;
  }

  .header-meta {
    display: flex;
    gap: var(--md-sys-spacing-6, 1.5rem);
    flex-wrap: wrap;
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: var(--md-sys-spacing-0-5, 0.125rem);
  }

  .meta-label {
    font: var(--md-sys-typescale-label-small-font);
    color: var(--md-sys-color-outline, #74777f);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .meta-value {
    font: var(--md-sys-typescale-body-medium-font);
    font-weight: 500;
    color: var(--md-sys-color-on-surface, #1b1b1f);
  }

  .meta-item.overdue .meta-value {
    color: var(--md-sys-color-error, #ba1a1a);
  }

  .meta-item.paid .meta-value {
    color: var(--md-sys-color-tertiary, #6b5778);
  }
</style>
