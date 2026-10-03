<script lang="ts">
import type { FormRetryStatus } from '@happyvertical/smrt-ui/form-retry';
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import InvoiceEditor from '../components/InvoiceEditor.svelte';
import type {
  InvoiceAllocationDraft,
  InvoicePreparationReview,
} from '../invoices/types.js';

let allocations = $state<InvoiceAllocationDraft[]>([
  { key: 'first', sourceId: 'reviewed-expense', amount: '125.00' },
]);
let mayReadSources = $state(true);
let canEdit = $state(true);
let message = $state('');
let retryStatus = $state<FormRetryStatus>('idle');
let review = $state<InvoicePreparationReview>({
  label: 'Awaiting review',
  message:
    'This example simulates server responses. It does not reserve sources or approve invoices.',
});
let sequence = 1;

function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const data = new FormData(event.currentTarget, event.submitter);
  const ids = data.getAll('sourceId').map(String);
  const amounts = data.getAll('allocationAmount').map(String);
  const removed = new Set(data.getAll('removeRow').map(String));
  allocations = ids.map((sourceId, index) => ({
    key: allocations[index]?.key ?? `row-${sequence++}`,
    sourceId,
    amount: amounts[index] ?? '',
    remove: removed.has(String(index)),
  }));
  if (data.get('intent') === 'addAllocation') {
    allocations = [
      ...allocations,
      { key: `row-${sequence++}`, sourceId: '', amount: '' },
    ];
    return;
  }
  retryStatus = 'failure';
  message =
    'Example server rejection: source availability changed. Your entries and request token are retained.';
  review = {
    label: 'Review required',
    message:
      'The server invalidated the previous approval. Reconcile sources before reviewing again.',
  };
}
</script>

<div class="preview">
  <Checkbox label="May read sources" bind:checked={mayReadSources} />
  <Checkbox label="May edit draft" bind:checked={canEdit} />
  <InvoiceEditor action="" currency="CAD" {allocations} {mayReadSources} {canEdit} {message} {review} {retryStatus}
    sources={[{ id: 'reviewed-expense', label: 'Reviewed supplier expense', availableMinor: 25000 }, { id: 'reviewed-time', label: 'Reviewed consulting time', availableMinor: 42500 }]}
    hiddenFields={[{ name: 'requestId', value: 'demo-request-retained' }]} onsubmit={submit} />
</div>

<style>.preview { display: grid; gap: var(--smrt-spacing-4); }</style>
