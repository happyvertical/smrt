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
  'purchase-order-editor': {
    id: 'purchase-order-editor',
    label: 'Purchase / Award Editor',
    description:
      'Native allocation preparation, review and explicit confirmation',
    icon: 'file-text',
    category: 'form',
    order: 30,
    propsInterface: 'PurchaseOrderEditorProps',
  },
  'purchase-source-selector': {
    id: 'purchase-source-selector',
    label: 'Purchasing Source',
    description: 'Caller-authorized vendor and source selection',
    icon: 'list',
    category: 'form',
    order: 31,
    propsInterface: 'PurchaseSourceSelectorProps',
  },

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

  'pricing-version-summary': {
    id: 'pricing-version-summary',
    label: 'Pricing Version Summary',
    description: 'Retained estimate version and source amounts',
    icon: 'file-text',
    category: 'display',
    order: 30,
    propsInterface: 'PricingVersionSummaryProps',
  },
  'pricing-version-decision': {
    id: 'pricing-version-decision',
    label: 'Pricing Version Decision',
    description: 'Caller-owned native decisions over retained pricing',
    icon: 'file-text',
    category: 'form',
    order: 31,
    propsInterface: 'PricingVersionDecisionProps',
  },
  'customer-directory': {
    id: 'customer-directory',
    label: 'Customer Directory',
    description: 'Searchable and paginated customer directory',
    icon: 'users',
    category: 'list',
    order: 1,
    propsInterface: 'CustomerDirectoryProps',
  },
  'customer-detail': {
    id: 'customer-detail',
    label: 'Customer Detail',
    description: 'Customer identity, terms, addresses, and contacts',
    icon: 'user',
    category: 'display',
    order: 2,
    propsInterface: 'CustomerDetailProps',
  },
  'customer-form': {
    id: 'customer-form',
    label: 'Customer Form',
    description: 'Native create and edit form for customer data',
    icon: 'edit',
    category: 'form',
    order: 3,
    propsInterface: 'CustomerFormProps',
  },
  'vendor-directory': {
    id: 'vendor-directory',
    label: 'Vendor Directory',
    description: 'Searchable and paginated vendor directory',
    icon: 'users',
    category: 'list',
    order: 4,
    propsInterface: 'VendorDirectoryProps',
  },
  'vendor-detail': {
    id: 'vendor-detail',
    label: 'Vendor Detail',
    description: 'Vendor identity, purchasing terms, and contacts',
    icon: 'building',
    category: 'display',
    order: 5,
    propsInterface: 'VendorDetailProps',
  },
  'vendor-form': {
    id: 'vendor-form',
    label: 'Vendor Form',
    description: 'Native create and edit form for vendor data',
    icon: 'edit',
    category: 'form',
    order: 6,
    propsInterface: 'VendorFormProps',
  },
  'customer-select': {
    id: 'customer-select',
    label: 'Customer Select',
    description:
      'Searchable customer picker for relation fields; the caller supplies the lookup',
    icon: 'users',
    category: 'form',
    order: 10,
    propsInterface: 'CustomerSelectProps',
    selects: '@happyvertical/smrt-commerce:Customer',
  },
  'vendor-select': {
    id: 'vendor-select',
    label: 'Vendor Select',
    description:
      'Searchable vendor picker for relation fields; the caller supplies the lookup',
    icon: 'building',
    category: 'form',
    order: 11,
    propsInterface: 'VendorSelectProps',
    selects: '@happyvertical/smrt-commerce:Vendor',
  },
  'party-contact-fields': {
    id: 'party-contact-fields',
    label: 'Party Contact Fields',
    description: 'Repeatable native contact editor shared by party forms',
    icon: 'contact',
    category: 'form',
    order: 7,
    propsInterface: 'PartyContactFieldsProps',
  },
  'invoice-editor': {
    id: 'invoice-editor',
    label: 'Invoice Preparation',
    description:
      'General invoice lines, exact totals and optional allocation fields',
    icon: 'file-text',
    category: 'form',
    order: 8,
    propsInterface: 'InvoiceEditorProps',
  },
  'invoice-review': {
    id: 'invoice-review',
    label: 'Invoice Review',
    description: 'Caller-authoritative review and approval presentation',
    icon: 'file-text',
    category: 'display',
    order: 9,
    propsInterface: 'InvoiceReviewProps',
  },
  'invoice-card': {
    id: 'invoice-card',
    label: 'Invoice Card',
    description: 'Compact invoice display with status and amount',
    icon: 'file-text',
    category: 'display',
    order: 20,
    propsInterface: 'InvoiceCardProps',
  },
  'invoice-header': {
    id: 'invoice-header',
    label: 'Invoice Header',
    description: 'Invoice header with customer and date information',
    icon: 'file-text',
    category: 'display',
    order: 21,
    propsInterface: 'InvoiceHeaderProps',
  },
  'invoice-line-items': {
    id: 'invoice-line-items',
    label: 'Invoice Line Items',
    description: 'Table of invoice line items',
    icon: 'list',
    category: 'list',
    order: 22,
    propsInterface: 'InvoiceLineItemsProps',
  },
  'invoice-totals': {
    id: 'invoice-totals',
    label: 'Invoice Totals',
    description: 'Invoice subtotal, tax, and total display',
    icon: 'calculator',
    category: 'display',
    order: 23,
    propsInterface: 'InvoiceTotalsProps',
  },
  'invoice-actions': {
    id: 'invoice-actions',
    label: 'Invoice Actions',
    description: 'Action buttons for invoice operations',
    icon: 'more-horizontal',
    category: 'action',
    order: 24,
    propsInterface: 'InvoiceActionsProps',
  },
  'unbilled-items': {
    id: 'unbilled-items',
    label: 'Unbilled Items',
    description: 'List of items ready for billing',
    icon: 'clock',
    category: 'list',
    order: 25,
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
