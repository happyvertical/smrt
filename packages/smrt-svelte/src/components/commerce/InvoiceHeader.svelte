<script lang="ts">
/**
 * InvoiceHeader - Invoice metadata display
 *
 * Shows invoice number, status, dates, and customer info.
 */

export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'paid'
  | 'overdue'
  | 'cancelled';

interface Props {
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

// Status display config
const statusConfig: Record<
  InvoiceStatus,
  { label: string; bg: string; text: string }
> = {
  draft: { label: 'Draft', bg: '#f3f4f6', text: '#6b7280' },
  sent: { label: 'Sent', bg: '#dbeafe', text: '#1e40af' },
  viewed: { label: 'Viewed', bg: '#e0e7ff', text: '#4338ca' },
  paid: { label: 'Paid', bg: '#dcfce7', text: '#166534' },
  overdue: { label: 'Overdue', bg: '#fee2e2', text: '#dc2626' },
  cancelled: { label: 'Cancelled', bg: '#fecaca', text: '#991b1b' },
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
    gap: 1.5rem;
    padding: 1.5rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    flex-wrap: wrap;
  }

  .header-main {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .invoice-title {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .invoice-number {
    font-size: 1.25rem;
    font-weight: 600;
    color: #111827;
    margin: 0;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 500;
    border-radius: 9999px;
    text-transform: capitalize;
  }

  .invoice-context {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .context-item {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    color: #6b7280;
  }

  .context-item svg {
    flex-shrink: 0;
  }

  .header-meta {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .meta-label {
    font-size: 0.75rem;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .meta-value {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  .meta-item.overdue .meta-value {
    color: #dc2626;
  }

  .meta-item.paid .meta-value {
    color: #16a34a;
  }
</style>
