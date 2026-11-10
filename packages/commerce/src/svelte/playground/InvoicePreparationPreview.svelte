<script lang="ts">
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import InvoiceEditor from '../components/InvoiceEditor.svelte';
import type { MoneyEditorProps } from '../invoices/types.js';

let canEdit = $state(true);
let frozen = $state(false);
const taxCodes: MoneyEditorProps['taxCodes'] = [
  {
    id: 'gst',
    code: 'GST',
    name: 'GST',
    kind: 'taxable',
    components: [{ taxComponentId: 'gst', percent: '5', compound: false }],
  },
  {
    id: 'gst-pst',
    code: 'GST+PST',
    name: 'GST+PST',
    componentNames: { gst: 'GST', pst: 'PST' },
    kind: 'taxable',
    components: [
      { taxComponentId: 'gst', percent: '5', compound: false },
      { taxComponentId: 'pst', percent: '7', compound: false },
    ],
  },
  {
    id: 'exempt',
    code: 'Exempt',
    name: 'Exempt',
    kind: 'exempt',
    components: [],
  },
];
const draft: MoneyEditorProps['draft'] = {
  currency: 'CAD',
  lineAmountType: 'exclusive',
  roundingScope: 'line',
  lines: [
    {
      id: 'consulting',
      description: 'Consulting services',
      quantity: '1.5',
      unitPrice: '100.00',
      discountType: 'percent',
      discountValue: '10',
      taxMode: 'inherit',
      inheritedTaxCodeId: 'gst',
      inheritedTaxCodeSource: 'product',
    },
    {
      id: 'stand',
      description: 'Laptop stand',
      quantity: '1',
      unitPrice: '49.99',
      discountType: 'none',
      discountValue: '0',
      taxMode: 'inherit',
      inheritedTaxCodeId: 'gst-pst',
      inheritedTaxCodeSource: 'app',
    },
  ],
};
// The stored snapshot is what the server froze at issue; the editor never recomputes it.
const stored: MoneyEditorProps['stored'] = {
  lineAmountType: 'exclusive',
  roundingScope: 'line',
  subtotalMinor: 18499,
  discountTotalMinor: 1500,
  taxMinor: 1275,
  totalMinor: 19774,
  taxes: [
    {
      id: 'gst',
      taxComponentId: 'gst',
      name: 'GST',
      percent: '5',
      taxableMinor: 18499,
      taxMinor: 925,
    },
    {
      id: 'pst',
      taxComponentId: 'pst',
      name: 'PST',
      percent: '7',
      taxableMinor: 4999,
      taxMinor: 350,
    },
  ],
};
const money = $derived<MoneyEditorProps>(
  frozen
    ? { mode: 'v2', draft, taxCodes, frozen: true, status: 'SENT', stored }
    : { mode: 'v2', draft, taxCodes },
);
function submit(event: SubmitEvent) {
  event.preventDefault();
}
</script>
<div class="preview">
  <Checkbox label="May edit invoice" bind:checked={canEdit} />
  <Checkbox label="Issued (frozen snapshot)" bind:checked={frozen} />
  {#key frozen}
    <InvoiceEditor action="" {money} {canEdit} hiddenFields={[{ name: 'requestId', value: 'demo-request-retained' }]} onsubmit={submit} />
  {/key}
</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
.preview { display: grid; gap: var(--smrt-spacing-4); }
}
</style>
