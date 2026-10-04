<script lang="ts">
import { Checkbox } from '@happyvertical/smrt-ui/forms';
import ExpenseForm from '../components/ExpenseForm.svelte';
import ExpenseReviewPanel from '../components/ExpenseReviewPanel.svelte';
import type { ExpenseDraftValues } from '../types.js';

let canEdit = $state(true);
let correcting = $state(false);
let message = $state('');
let values = $state<ExpenseDraftValues>({
  amount: '125.00',
  currency: 'CAD',
  incurredOn: '2026-10-03',
  description: 'Supplier materials',
  category: 'materials',
  vendorId: 'vendor-a',
  commitmentId: '',
  paidBy: 'company',
  paidByProfileId: '',
  correctionReason: '',
});
function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const data = new FormData(event.currentTarget, event.submitter);
  values = Object.fromEntries(
    Object.keys(values).map((key) => [key, String(data.get(key) ?? '')]),
  ) as unknown as ExpenseDraftValues;
  message =
    'Example server rejection: a receipt is required by this application. Your entries and request token are retained.';
}
</script>
<div class="preview">
  <Checkbox label="May edit expense" bind:checked={canEdit} />
  <Checkbox label="Correction workflow" bind:checked={correcting} />
  <ExpenseForm action="" {values} {canEdit} {correcting} {message} vendors={[{ id: 'vendor-a', label: 'Supplier A' }]} hiddenFields={[{ name: 'requestId', value: 'demo-expense-request' }]} onsubmit={submit} />
  <ExpenseReviewPanel expense={{ description: 'Supplier materials', amount: 12500, currency: 'CAD', incurredOn: '2026-10-03', statusLabel: 'Unreviewed' }} duplicates={[{ id: 'expense-other', label: 'Possible matching expense', reason: 'The server found matching receipt evidence. A reviewer must decide.' }]} history={[{ id: 'correction', label: 'Description corrected', detail: 'Caller-provided correction history' }]} receipts={{ attachments: [{ id: 'receipt', name: 'Receipt.pdf', mimeType: 'application/pdf' }] }} />
</div>
<style>.preview { display: grid; gap: var(--smrt-spacing-4); }</style>
