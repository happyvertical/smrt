<script lang="ts">
/**
 * InvoiceHeader - Invoice metadata display
 *
 * Shows invoice number, status, dates, and customer info.
 */

import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type { InvoiceStatus } from '../types.js';

const { t } = useI18n();

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

// Status display config - uses Material 3 color roles
const statusConfig: Record<
  InvoiceStatus,
  { label: string; bg: string; text: string }
> = {
  draft: {
    label: 'Draft',
    bg: 'var(--smrt-color-surface-variant, #e7e0ec)',
    text: 'var(--smrt-color-on-surface-variant, #49454f)',
  },
  sent: {
    label: 'Sent',
    bg: 'var(--smrt-color-primary-container, #d3e3fd)',
    text: 'var(--smrt-color-on-primary-container, #041e49)',
  },
  viewed: {
    label: 'Viewed',
    bg: 'var(--smrt-color-secondary-container, #e3e0f9)',
    text: 'var(--smrt-color-on-secondary-container, #1d192b)',
  },
  paid: {
    label: 'Paid',
    bg: 'var(--smrt-color-tertiary-container, #ddf5e5)',
    text: 'var(--smrt-color-on-tertiary-container, #0c1f15)',
  },
  overdue: {
    label: 'Overdue',
    bg: 'var(--smrt-color-error-container, #ffdad6)',
    text: 'var(--smrt-color-on-error-container, #410002)',
  },
  cancelled: {
    label: 'Cancelled',
    bg: 'var(--smrt-color-error-container, #ffdad6)',
    text: 'var(--smrt-color-error, #ba1a1a)',
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
      <span class="meta-label">{t(M['commerce.invoice_header.issue_date'])}</span>
      <span class="meta-value">{formatDate(issueDate)}</span>
    </div>

    {#if dueDate}
      <div class="meta-item" class:overdue={isOverdue}>
        <span class="meta-label">{t(M['commerce.invoice_header.due_date'])}</span>
        <span class="meta-value">{formatDate(dueDate)}</span>
      </div>
    {/if}

    {#if paidDate && status === 'paid'}
      <div class="meta-item paid">
        <span class="meta-label">{t(M['commerce.invoice_header.paid_date'])}</span>
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
    gap: var(--smrt-spacing-6, 1.5rem);
    padding: var(--smrt-spacing-6, 1.5rem);
    background: var(--smrt-color-surface, #ffffff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    flex-wrap: wrap;
  }

  .header-main {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .invoice-title {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
  }

  .invoice-number {
    font: var(--smrt-typography-title-large-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #1c1b1f);
    margin: 0;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-3, 0.75rem);
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-full, 9999px);
    text-transform: capitalize;
  }

  .invoice-context {
    display: flex;
    gap: var(--smrt-spacing-4, 1rem);
    flex-wrap: wrap;
  }

  .context-item {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1_5, 0.375rem);
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant, #49454f);
  }

  .context-item svg {
    flex-shrink: 0;
  }

  .header-meta {
    display: flex;
    gap: var(--smrt-spacing-6, 1.5rem);
    flex-wrap: wrap;
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-0_5, 0.125rem);
  }

  .meta-label {
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant, #49454f);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .meta-value {
    font: var(--smrt-typography-body-medium-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .meta-item.overdue .meta-value {
    color: var(--smrt-color-error, #ba1a1a);
  }

  .meta-item.paid .meta-value {
    color: var(--smrt-color-tertiary, #006c4c);
  }
</style>
