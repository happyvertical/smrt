<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { Q } from '../quote-i18n.js';
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
const { t } = useI18n();
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
    message = t(Q['commerce.quote.demo_added']);
  } else if (intent.startsWith('removeLine:')) {
    values.lines = values.lines.filter(
      (line) => line.id !== intent.slice('removeLine:'.length),
    );
    message = t(Q['commerce.quote.demo_removed']);
  } else {
    errors = { total: t(Q['commerce.quote.demo_error']) };
    message = t(Q['commerce.quote.demo_rejected']);
  }
}
</script>
<p>{t(Q['commerce.quote.demo_notice'])}</p>
<Button variant="secondary" onclick={() => {readonly=!readonly;}}>{t(Q[readonly ? 'commerce.quote.demo_enable' : 'commerce.quote.demo_readonly'])}</Button>
<QuoteEditor {kind} {values} counterparties={[{id:'party-1',label:'North Studio'}]} action="" {errors} {message} {readonly} hiddenFields={[{name:'requestId',value:'demo-request-1'},{name:'expectedTenantId',value:'demo-tenant'}]} onsubmit={submit} />
<QuoteRevisionComparison {previous} {current} />
