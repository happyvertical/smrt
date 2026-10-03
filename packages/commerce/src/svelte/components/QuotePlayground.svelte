<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  QuoteDocumentKind,
  QuoteDraftValues,
  QuoteRevision,
} from '../quote-types.js';
import QuoteEditor from './QuoteEditor.svelte';
import QuoteRevisionComparison from './QuoteRevisionComparison.svelte';
/** Interactive presentation demo; all outcomes are local and no financial record is written. */
export interface Props {
  /** Start with a vendor quotation or customer estimate. */
  kind?: QuoteDocumentKind;
}
let { kind = 'vendor-quotation' }: Props = $props();
let values = $state<QuoteDraftValues>({
  counterpartyId: 'party-1',
  reference: 'Q-104',
  date: '2026-10-03',
  validUntil: '',
  currency: 'CAD',
  total: '1200.00',
  tax: '60.00',
  scope: 'Supply design services',
  inclusions: 'Two revisions',
  exclusions: 'Printing',
  reason: 'Updated scope',
  lines: [
    {
      id: 'line-1',
      description: 'Design services',
      quantity: '10',
      unitRate: '114.00',
    },
  ],
});
let message = $state('');
let readonly = $state(false);
let row = 1;
let errors = $state<Record<string, string>>({});
const previous = $derived<QuoteRevision>({
  id: 'revision-1',
  kind,
  label: 'Revision 1',
  status: 'Superseded',
  counterparty: 'North Studio',
  total: { currency: 'CAD', minorUnitDigits: 2, amountMinor: 100000 },
  scope: 'Original design scope',
});
const current = $derived<QuoteRevision>({
  ...previous,
  id: 'revision-2',
  label: 'Revision 2',
  status: 'Draft',
  total: { currency: 'CAD', minorUnitDigits: 2, amountMinor: 120000 },
  scope: 'Design and two revisions',
  reason: 'Updated scope',
});
function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const data = new FormData(event.currentTarget, event.submitter);
  const text = (name: string) => String(data.get(name) ?? '');
  const strings = (name: string) => data.getAll(name).map(String);
  const ids = strings('lineId');
  values = {
    counterpartyId: text('counterpartyId'),
    reference: text('reference'),
    date: text('date'),
    validUntil: text('validUntil'),
    currency: text('currency'),
    total: text('total'),
    tax: text('tax'),
    scope: text('scope'),
    inclusions: text('inclusions'),
    exclusions: text('exclusions'),
    reason: text('reason'),
    lines: ids.map((id, index) => ({
      id,
      description: strings('lineDescription')[index] ?? '',
      quantity: strings('lineQuantity')[index] ?? '',
      unitRate: strings('lineUnitRate')[index] ?? '',
    })),
  };
  const intent = text('intent');
  if (intent === 'addLine') {
    values.lines = [
      ...values.lines,
      { id: `line-${++row}`, description: '', quantity: '', unitRate: '' },
    ];
    message = 'Demo: line added; entered values retained.';
  } else if (intent.startsWith('removeLine:')) {
    values.lines = values.lines.filter(
      (line) => line.id !== intent.slice('removeLine:'.length),
    );
    message = 'Demo: line removed; entered values retained.';
  } else {
    errors = { total: 'Demo server validation: confirm the total.' };
    message =
      'Demo rejected submission. Values and request identity remain available for retry.';
  }
}
</script>
<p>This demo simulates validation failure locally. It does not save a quotation or estimate.</p>
<Button variant="secondary" onclick={() => {readonly=!readonly;}}>{readonly ? 'Enable editing' : 'Preview read only'}</Button>
<QuoteEditor {kind} {values} counterparties={[{id:'party-1',label:'North Studio'}]} action="" {errors} {message} {readonly} hiddenFields={[{name:'requestId',value:'demo-request-1'},{name:'expectedTenantId',value:'demo-tenant'}]} onsubmit={submit} />
<QuoteRevisionComparison {previous} {current} />
