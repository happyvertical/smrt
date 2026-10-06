<script lang="ts">
import InvoiceCard from '../../../components/InvoiceCard.svelte';
import InvoiceHeader from '../../../components/InvoiceHeader.svelte';
import InvoiceLineItems from '../../../components/InvoiceLineItems.svelte';
import InvoiceTotals from '../../../components/InvoiceTotals.svelte';
import type {
  RetainedInvoiceCardView,
  RetainedInvoiceLineItemsView,
  RetainedInvoiceTotalsView,
} from '../../../invoice-display.js';

const card: RetainedInvoiceCardView = {
  invoiceNumber: 'INV-retained',
  status: 'posting-blocked',
  statusLabel: 'Posting blocked',
  issueDate: '2026-10-05T12:00:00Z',
  customerName: 'Example client',
  totalMinor: 10499,
  currency: 'CAD',
};
const lines: RetainedInvoiceLineItemsView = {
  currency: 'CAD',
  lines: [
    {
      id: 'line-1',
      description: 'Retained labour',
      quantity: '1.0005',
      unitPriceMinor: 1001,
      amountMinor: 1001,
      sourceLabel: 'Approved time revision 4',
      discountLabel: 'Flat discount CAD 0.00',
      taxLabels: ['GST explicit 0%', 'PST retained 5%'],
      correctionLabel: 'Corrects invoice line revision 3',
    },
  ],
  subtotalMinor: 9999,
};
const totals: RetainedInvoiceTotalsView = {
  currency: 'CAD',
  subtotalMinor: 9999,
  discountMinor: 0,
  taxes: [
    { id: 'gst', label: 'GST retained', amountMinor: 0 },
    { id: 'pst', label: 'PST retained', amountMinor: 500 },
  ],
  holdbackMinor: 0,
  holdbackLabel: 'Construction holdback retained',
  totalMinor: 10499,
};
</script>

<InvoiceHeader retained={card} />
<InvoiceCard retained={card}>
  {#snippet details(view)}<span>Card evidence · {view.status}</span>{/snippet}
</InvoiceCard>
<InvoiceLineItems retained={lines}>
  {#snippet details(line)}<span>Line evidence · {line.id}</span>{/snippet}
</InvoiceLineItems>
<InvoiceTotals retained={totals}>
  {#snippet details(view)}<span>Totals evidence · {view.currency}</span>{/snippet}
</InvoiceTotals>
