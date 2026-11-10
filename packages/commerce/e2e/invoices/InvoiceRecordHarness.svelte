<script lang="ts">
import type { ScreenRelation } from '@happyvertical/smrt-svelte/screens';
import InvoiceRecordScreen from '../../src/svelte/components/InvoiceRecordScreen.svelte';

let { sourceKind = 'invoice' as 'invoice' | 'credit_note' } = $props();
let actionCount = $state(0);

const relations: readonly ScreenRelation[] = [{
  model: '@happyvertical/smrt-commerce:InvoiceLineItem',
  field: 'invoiceId',
  label: 'Line items',
  kind: 'items',
  sort: 'lineNumber',
  columns: [
    { key: 'description', label: 'Description' },
    { key: 'quantity', label: 'Quantity', role: 'quantity' },
    { key: 'unitPrice', label: 'Unit price', role: 'money', summarize: false },
    { key: 'amount', label: 'Amount', role: 'money' },
  ],
}];

const screen = {
  definition: {
    objectRef: '@happyvertical/smrt-commerce:Invoice',
    className: 'Invoice',
    fields: {
      invoiceNumber: { type: 'text' as const, role: ['title', 'identifier'] as const },
      status: { type: 'text' as const, role: 'status' as const },
      issueDate: { type: 'datetime' as const, format: 'date' as const },
      customerId: { type: 'foreignKey' as const, role: 'party' as const },
      totalAmount: { type: 'integer' as const, role: 'total' as const, format: 'money' as const },
    },
  },
  record: {
    id: 'invoice-record',
    invoiceNumber: sourceKind === 'invoice' ? 'INV-HOST-1' : 'CN-HOST-1',
    status: 'sent',
    issueDate: '2026-10-13',
    customerId: 'customer-host',
    totalAmount: 10_500,
  },
  relations,
  mode: 'view' as const,
  currency: 'CAD',
  locale: 'en-CA',
  loaders: {
    records: async () => ({
      currency: 'CAD',
      rows: [{
        id: 'line-host',
        title: 'Stored service',
        cells: { description: 'Stored service', quantity: 1, unitPrice: 10_000, amount: 10_000 },
      }],
    }),
  },
};

const data = $derived({
  invoiceId: 'invoice-record',
  kind: sourceKind,
  status: 'SENT',
  currency: 'CAD',
  storedTotals: {
    subtotal: 10_000,
    discount: 0,
    tax: 500,
    total: 10_500,
    lineAmountType: 'exclusive' as const,
    roundingScope: 'document' as const,
    showNetSubtotal: true,
    taxes: [{ taxComponentId: 'gst', name: 'GST', percent: '5', taxable: 10_000, tax: 500 }],
  },
  creditNotes: sourceKind === 'invoice'
    ? [{ id: 'credit-host', invoiceNumber: 'CN-HOST-1', status: 'SENT', issueDate: '2026-10-14T00:00:00.000Z', totalMinor: 1_500 }]
    : [],
});
</script>

<div data-theme="material" data-color-scheme="light">
  <InvoiceRecordScreen
    {screen}
    {data}
    canCreateCreditNote={true}
    onCreateCreditNote={() => (actionCount += 1)}
  />
  <output aria-live="polite">Credit action invoked: {actionCount}</output>
</div>
