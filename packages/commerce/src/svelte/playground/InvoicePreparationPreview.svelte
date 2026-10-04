<script lang="ts">
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import InvoiceAllocationFields from '../components/InvoiceAllocationFields.svelte';
import InvoiceEditor from '../components/InvoiceEditor.svelte';
import {
  invoiceFieldNames,
  invoiceLineFieldNames,
} from '../invoices/fields.js';
import type {
  InvoiceAllocationDraft,
  InvoiceDraftValues,
} from '../invoices/types.js';

let values = $state<InvoiceDraftValues>({
  customerId: 'customer',
  issuedOn: '2026-10-03',
  dueOn: '2026-11-03',
  currency: 'CAD',
  paymentTerms: 'Net 30',
  taxRate: '5',
  lines: [
    {
      key: 'first',
      description: 'Consulting services',
      sku: 'SERVICE',
      quantity: '1.5',
      unitPrice: '100.00',
      discountType: 'percent',
      discountValue: '10',
      taxMode: 'inherit',
      taxRate: '0',
    },
  ],
});
let allocations = $state<InvoiceAllocationDraft[]>([
  { key: 'allocation', sourceId: 'reviewed-expense', amount: '125.00' },
]);
let mayReadSources = $state(true);
let canEdit = $state(true);
let message = $state('');
let sequence = 1;
function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const data = new FormData(event.currentTarget, event.submitter);
  const text = (name: string) => String(data.get(name) ?? '');
  values = {
    ...values,
    ...Object.fromEntries(
      Object.entries(invoiceFieldNames)
        .filter(([key]) => key !== 'intent')
        .map(([key, name]) => [key, text(name)]),
    ),
    lines: data
      .getAll('lineKey')
      .map(
        (_, index) =>
          Object.fromEntries(
            Object.entries(invoiceLineFieldNames).map(([key, name]) => [
              key,
              String(data.getAll(name)[index] ?? ''),
            ]),
          ) as unknown as InvoiceDraftValues['lines'][number],
      ),
  };
  allocations = data.getAll('sourceId').map((sourceId, index) => ({
    key: allocations[index]?.key ?? `allocation-${sequence++}`,
    sourceId: String(sourceId),
    amount: String(data.getAll('allocationAmount')[index] ?? ''),
    remove: data.getAll('removeRow').includes(String(index)),
  }));
  const intent = text('intent');
  if (intent === 'addLine')
    values = {
      ...values,
      lines: [
        ...values.lines,
        {
          key: `line-${sequence++}`,
          description: '',
          sku: '',
          quantity: '1',
          unitPrice: '',
          discountType: 'flat',
          discountValue: '0',
          taxMode: 'inherit',
          taxRate: '0',
        },
      ],
    };
  else if (intent.startsWith('removeLine:'))
    values = {
      ...values,
      lines: values.lines.filter(
        (line) => line.key !== intent.slice('removeLine:'.length),
      ),
    };
  else if (intent === 'addAllocation')
    allocations = [
      ...allocations,
      { key: `allocation-${sequence++}`, sourceId: '', amount: '' },
    ];
  else
    message =
      'Example server rejection: entries and request token retained. The server revalidates customer, prices and tax before saving.';
}
</script>
<div class="preview">
  <Checkbox label="May read allocation sources" bind:checked={mayReadSources} />
  <Checkbox label="May edit invoice" bind:checked={canEdit} />
  <InvoiceEditor action="" {values} {canEdit} {message} customers={[{ id: 'customer', label: 'Example customer' }]} hiddenFields={[{ name: 'requestId', value: 'demo-request-retained' }]} onsubmit={submit}>
    {#snippet children(current)}
    <InvoiceAllocationFields currency={current.currency} {allocations} {canEdit} {mayReadSources} sources={[{ id: 'reviewed-expense', label: 'Reviewed supplier expense', availableMinor: 25000 }]} />
    {/snippet}
  </InvoiceEditor>
</div>
<style>.preview { display: grid; gap: var(--smrt-spacing-4); }</style>
