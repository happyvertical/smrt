<script lang="ts">
import ExpenseReceiptCapture from '../src/svelte/components/ExpenseReceiptCapture.svelte';
import ExpenseReviewQueue from '../src/svelte/components/ExpenseReviewQueue.svelte';
/** Native lifecycle proof fixture. */
export interface Props { reason?: string; message?: string; }
let { reason = '', message = '' }: Props = $props();
</script>
<div data-theme="material" data-color-scheme="light">
  <ExpenseReceiptCapture action="/attach" canAttach hiddenFields={[{ name: 'expenseId', value: 'expense-a' }, { name: 'requestId', value: 'receipt-key' }]} />
  <ExpenseReviewQueue canReview expenses={[{ id: 'expense-a', description: 'Materials', amount: 12500, currency: 'CAD', incurredOn: '2026-10-05', costObjectType: '@example/jobs:Job', costObjectId: 'job-a', statusLabel: 'Unreviewed', action: '/queue-review', canReview: true, reason, message, hiddenFields: [{ name: 'requestId', value: 'queue-key' }] }]} />
</div>
