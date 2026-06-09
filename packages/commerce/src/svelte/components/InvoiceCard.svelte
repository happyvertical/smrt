<script lang="ts">
/**
 * InvoiceCard - Invoice list/grid card
 * refactored for Material 3
 *
 * Compact card view for displaying invoices in lists.
 */

import { ripple } from '@happyvertical/smrt-svelte';
import type { InvoiceData, InvoiceStatus } from '../types.js';

/** Props for InvoiceCard component */
export interface Props {
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

// Map status to M3 classes
const statusClass = $derived.by(() => {
  switch (invoice.status) {
    case 'paid':
      return 'status-paid';
    case 'overdue':
      return 'status-error';
    case 'sent':
      return 'status-info';
    case 'viewed':
      return 'status-info';
    case 'cancelled':
      return 'status-error';
    default:
      return 'status-default';
  }
});

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
  <a class="invoice-card" {href} use:ripple>
    <div class="card-header">
      <span class="invoice-number">{invoice.invoiceNumber}</span>
      <span class="status-badge {isOverdue ? 'status-error' : statusClass}">
        {isOverdue ? 'Overdue' : invoice.status}
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
  <button type="button" class="invoice-card" onclick={onclick} use:ripple>
    <div class="card-header">
      <span class="invoice-number">{invoice.invoiceNumber}</span>
      <span class="status-badge {isOverdue ? 'status-error' : statusClass}">
        {isOverdue ? 'Overdue' : invoice.status}
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
    gap: var(--smrt-spacing-3, 12px);
    padding: var(--smrt-spacing-4, 16px);
    background-color: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-large, 12px);
    text-decoration: none;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    transition: 
      background-color var(--smrt-duration-medium, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1)),
      box-shadow var(--smrt-duration-medium, 200ms) var(--smrt-easing-standard, cubic-bezier(0.2, 0, 0, 1));
    text-align: left;
    width: 100%;
    border: none;
    position: relative;
    overflow: hidden;
    box-shadow: var(--smrt-elevation-level1);
  }

  @media (prefers-reduced-motion: reduce) {
    .invoice-card {
      transition: none;
    }
  }

  .invoice-card:hover {
    background-color: var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-level2);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .invoice-number {
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }

  .status-badge {
    display: inline-flex;
    padding: 0 var(--smrt-spacing-2, 8px);
    height: 20px;
    align-items: center;
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border-radius: var(--smrt-radius-full, 10px);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Status Badge Colors */
  .status-default { 
    background-color: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
  .status-paid {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .status-info {
    background-color: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .status-error {
    background-color: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
  }

  .customer-name {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }

  .invoice-amount {
    font: var(--smrt-typography-headline-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
    font-variant-numeric: tabular-nums;
  }

  .card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
    opacity: 0.8;
  }

  .due-date.overdue {
    color: var(--smrt-color-error);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
</style>