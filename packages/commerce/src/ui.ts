/**
 * Commerce Module UI Slot Declarations
 *
 * This file defines the UI extension points for the commerce module.
 * UI components are implemented in the ./svelte subpath.
 *
 * @example Usage
 * ```typescript
 * // In application code
 * import { COMMERCE_MODULE_META } from '@happyvertical/smrt-commerce';
 * console.log(COMMERCE_MODULE_META.uiSlots);
 * ```
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Commerce module UI slots
 */
export const COMMERCE_UI_SLOTS: Record<string, ModuleUISlot> = {
  'quote-editor': {
    id: 'quote-editor',
    label: 'Quotation / Estimate Editor',
    description:
      'Native retained-value document editor with caller-owned actions',
    icon: 'file-text',
    category: 'form',
    order: 20,
    propsInterface: 'QuoteEditorProps',
  },
  'quote-revision-history': {
    id: 'quote-revision-history',
    label: 'Quote Revision History',
    description: 'Read-only retained quotation and estimate revisions',
    icon: 'clock',
    category: 'list',
    order: 21,
    propsInterface: 'QuoteRevisionHistoryProps',
  },
  'quote-revision-comparison': {
    id: 'quote-revision-comparison',
    label: 'Quote Revision Comparison',
    description: 'Compare explicit minor-unit revision totals and scope',
    icon: 'file-text',
    category: 'display',
    order: 22,
    propsInterface: 'QuoteRevisionComparisonProps',
  },

  'invoice-card': {
    id: 'invoice-card',
    label: 'Invoice Card',
    description: 'Compact invoice display with status and amount',
    icon: 'file-text',
    category: 'display',
    order: 1,
    propsInterface: 'InvoiceCardProps',
  },
  'invoice-header': {
    id: 'invoice-header',
    label: 'Invoice Header',
    description: 'Invoice header with customer and date information',
    icon: 'file-text',
    category: 'display',
    order: 2,
    propsInterface: 'InvoiceHeaderProps',
  },
  'invoice-line-items': {
    id: 'invoice-line-items',
    label: 'Invoice Line Items',
    description: 'Table of invoice line items',
    icon: 'list',
    category: 'list',
    order: 3,
    propsInterface: 'InvoiceLineItemsProps',
  },
  'invoice-totals': {
    id: 'invoice-totals',
    label: 'Invoice Totals',
    description: 'Invoice subtotal, tax, and total display',
    icon: 'calculator',
    category: 'display',
    order: 4,
    propsInterface: 'InvoiceTotalsProps',
  },
  'invoice-actions': {
    id: 'invoice-actions',
    label: 'Invoice Actions',
    description: 'Action buttons for invoice operations',
    icon: 'more-horizontal',
    category: 'action',
    order: 5,
    propsInterface: 'InvoiceActionsProps',
  },
  'unbilled-items': {
    id: 'unbilled-items',
    label: 'Unbilled Items',
    description: 'List of items ready for billing',
    icon: 'clock',
    category: 'list',
    order: 6,
    propsInterface: 'UnbilledItemsProps',
  },
};

/**
 * Commerce module metadata
 */
export const COMMERCE_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-commerce',
  displayName: 'Commerce',
  description: 'Commerce models: contracts, invoices, payments',
  uiSlots: COMMERCE_UI_SLOTS,
  models: [
    'Customer',
    'Vendor',
    'Contract',
    'ContractLineItem',
    'Fulfillment',
    'FulfillmentLineItem',
    'Payment',
  ],
  collections: [
    'CustomerCollection',
    'VendorCollection',
    'ContractCollection',
    'ContractLineItemCollection',
    'FulfillmentCollection',
    'FulfillmentLineItemCollection',
    'PaymentCollection',
  ],
};
