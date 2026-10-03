<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { P } from '../purchasing-i18n.js';
import type {
  PurchaseDraftValues,
  PurchaseReviewSnapshot,
} from '../purchasing-types.js';
import PurchaseOrderEditor from './PurchaseOrderEditor.svelte';
import PurchaseSourceSelector from './PurchaseSourceSelector.svelte';
/** Interactive purchasing form demo; no record is written. */
export interface Props {
  /** Show the explicit retained-allocation reduction workflow. */
  reduction?: boolean;
}
let { reduction = false }: Props = $props();
const { t } = useI18n();
let values = $state<PurchaseDraftValues>({
  instrument: 'purchase-order',
  tax: '0.00',
  scope: 'Deliver design services',
  inclusions: 'Two review rounds',
  exclusions: 'Printing',
  reason: 'Agreed scope',
  allocations: [
    {
      id: 'allocation-a',
      label: 'Design services',
      amount: '1200.00',
      retained: true,
      sourceMinor: 120000,
      minimumMinor: 0,
      maximumMinor: 120000,
    },
  ],
});
let review = $state<PurchaseReviewSnapshot | undefined>();
let message = $state('');
let sequence = 1;
let source = $state({
  id: 'source-1',
  label: 'Quotation Q-104',
  vendor: 'North Studio',
});
// Demo-only CAD endpoint parser. Real callers validate using their owning money contract.
function demoCadMinor(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}
function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const data = new FormData(event.currentTarget, event.submitter);
  const text = (name: string) => String(data.get(name) ?? '');
  values = {
    instrument: text('instrument'),
    tax: text('tax'),
    scope: text('scope'),
    inclusions: text('inclusions'),
    exclusions: text('exclusions'),
    reason: text('reason'),
    allocations: data.getAll('allocationId').map((id, index) => ({
      ...values.allocations.find((row) => row.id === id)!,
      amount: String(data.getAll('allocationAmount')[index] ?? ''),
    })),
  };
  const intent = text('intent');
  if (intent === 'addAllocation') {
    values.allocations = [
      ...values.allocations,
      {
        id: `new-${++sequence}`,
        label: t(P['commerce.purchase.demo_additional'], { number: sequence }),
        amount: '',
      },
    ];
    review = undefined;
    message = t(P['commerce.purchase.demo_added']);
  } else if (intent.startsWith('removeAllocation:')) {
    values.allocations = values.allocations.filter(
      (row) => row.id !== intent.slice('removeAllocation:'.length),
    );
    review = undefined;
    message = t(P['commerce.purchase.demo_removed']);
  } else if (intent === 'review') {
    const amounts = values.allocations.map((row) => demoCadMinor(row.amount));
    const taxMinor = demoCadMinor(values.tax);
    const sum = amounts.reduce<bigint>(
      (total, amount) => total + BigInt(amount ?? 0),
      0n,
    );
    if (
      amounts.some((amount) => amount === null) ||
      taxMinor === null ||
      sum > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(taxMinor) > sum
    ) {
      review = undefined;
      message = t(P['commerce.purchase.demo_invalid']);
      return;
    }
    review = {
      fingerprint: 'demo-review',
      sourceLabel: `${source.vendor} / ${source.label}`,
      total: { currency: 'CAD', minorUnitDigits: 2, amountMinor: Number(sum) },
      taxMinor,
      scope: values.scope,
      notices: [t(P['commerce.purchase.demo_authority'])],
    };
    message = t(P['commerce.purchase.demo_review']);
  } else if (intent === 'edit') {
    review = undefined;
    message = t(P['commerce.purchase.demo_edit']);
  } else {
    message = t(P['commerce.purchase.demo_uncertain']);
  }
}
function selectSource(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const id = String(new FormData(event.currentTarget).get('source') ?? '');
  source =
    id === 'source-2'
      ? { id, label: 'Quotation Q-105', vendor: 'South Studio' }
      : { id: 'source-1', label: 'Quotation Q-104', vendor: 'North Studio' };
  review = undefined;
  message = t(P['commerce.purchase.demo_source']);
}
</script>
<p>{t(P['commerce.purchase.demo_notice'])}</p>
<Button variant="secondary" onclick={()=>{reduction=!reduction;review=undefined;}}>{reduction?t(P['commerce.purchase.demo_amendment']):t(P['commerce.purchase.demo_reduction'])}</Button>
<PurchaseSourceSelector disabled={reduction} action="" value={source.id} sources={[{id:'source-1',label:'Quotation Q-104',vendor:'North Studio'},{id:'source-2',label:'Quotation Q-105',vendor:'South Studio'},{id:'source-old',label:'Quotation Q-099',vendor:'Prior Vendor',disabled:true,notice:t(P['commerce.purchase.demo_unavailable'])}]} onsubmit={selectSource}/>
<PurchaseOrderEditor operation={reduction?'reduce':'amend'} {source} currency="CAD" minorUnitDigits={2} {values} instruments={[{value:'purchase-order',label:t(P['commerce.purchase.demo_order'])},{value:'agreement',label:t(P['commerce.purchase.demo_agreement'])}]} action="" {review} {message} hiddenFields={[{name:'requestId',value:'demo-purchase-request'},{name:'sourceId',value:source.id},{name:'predecessorId',value:'order-previous'}]} rowActions={{add:'addAllocation',removePrefix:'removeAllocation:'}} onsubmit={submit}/>
