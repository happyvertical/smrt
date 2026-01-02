<script lang="ts">
/**
 * InvoiceCard - Invoice list/grid card
 *
 * Compact card view for displaying invoices in lists.
 */

import type { InvoiceData, InvoiceStatus } from './types.js';

interface Props {
  /** Invoice data */
  invoice: InvoiceData;
  /** Currency code */
  currency?: 'CAD' | 'USD';
  /** Navigation href */
  href?: string;
  /** Click handler */
  onclick?: () => void;
}

const { invoice, currency = 'CAD', href, onclick }: Props = $props();

// Format money
function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

// Format date
function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-CA', {
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

const statusInfo = $derived(statusConfig[invoice.status] ?? statusConfig.draft);

// Check if overdue
const isOverdue = $derived.by(() => {
  if (invoice.status === 'paid' || invoice.status === 'cancelled') return false;
  if (!invoice.dueDate) return false;
  const due =
    typeof invoice.dueDate === 'string'
      ? new Date(invoice.dueDate)
      : invoice.dueDate;
  return due < new Date();
});
</script>

{#if href}
  <a class="invoice-card" {href}>
    <div class="card-header">
      <span class="invoice-number">{invoice.invoiceNumber}</span>
      <span
        class="status-badge"
        style:background-color={isOverdue ? statusConfig.overdue.bg : statusInfo.bg}
        style:color={isOverdue ? statusConfig.overdue.text : statusInfo.text}
      >
        {isOverdue ? 'Overdue' : statusInfo.label}
      </span>
    </div>

    <div class="card-body">
      {#if invoice.customerName}
        <span class="customer-name">{invoice.customerName}</span>
      {/if}
      <span class="invoice-amount">{formatMoney(invoice.totalAmount)}</span>
    </div>

    <div class="card-footer">
      <span class="issue-date">{formatDate(invoice.issueDate)}</span>
      {#if invoice.dueDate}
        <span class="due-date" class:overdue={isOverdue}>
          Due {formatDate(invoice.dueDate)}
        </span>
      {/if}
    </div>
  </a>
{:else}
  <button type="button" class="invoice-card" onclick={onclick}>
    <div class="card-header">
      <span class="invoice-number">{invoice.invoiceNumber}</span>
      <span
        class="status-badge"
        style:background-color={isOverdue ? statusConfig.overdue.bg : statusInfo.bg}
        style:color={isOverdue ? statusConfig.overdue.text : statusInfo.text}
      >
        {isOverdue ? 'Overdue' : statusInfo.label}
      </span>
    </div>

    <div class="card-body">
      {#if invoice.customerName}
        <span class="customer-name">{invoice.customerName}</span>
      {/if}
      <span class="invoice-amount">{formatMoney(invoice.totalAmount)}</span>
    </div>

    <div class="card-footer">
      <span class="issue-date">{formatDate(invoice.issueDate)}</span>
      {#if invoice.dueDate}
        <span class="due-date" class:overdue={isOverdue}>
          Due {formatDate(invoice.dueDate)}
        </span>
      {/if}
    </div>
  </button>
{/if}

<style>
  .invoice-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    text-decoration: none;
    color: inherit;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
    width: 100%;
  }

  .invoice-card:hover {
    border-color: #3b82f6;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .invoice-number {
    font-size: 0.875rem;
    font-weight: 600;
    color: #111827;
  }

  .status-badge {
    display: inline-flex;
    padding: 0.125rem 0.5rem;
    font-size: 0.625rem;
    font-weight: 500;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .customer-name {
    font-size: 0.875rem;
    color: #6b7280;
  }

  .invoice-amount {
    font-size: 1.25rem;
    font-weight: 600;
    color: #111827;
    font-variant-numeric: tabular-nums;
  }

  .card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.75rem;
    color: #9ca3af;
  }

  .due-date.overdue {
    color: #dc2626;
    font-weight: 500;
  }
</style>
