<script lang="ts">
import ExpenseReviewPanel from '../src/svelte/components/ExpenseReviewPanel.svelte';
let { message = '' }: { message?: string } = $props();
</script>
<ExpenseReviewPanel
  expense={{ description: 'Review materials', amount: 12500, currency: 'CAD', incurredOn: '2026-10-03', statusLabel: 'Unreviewed' }}
  canReview action="" {message}
  actions={[{ intent: 'approve', label: 'Approve expense' }, { intent: 'reject', label: 'Reject expense' }]}
  hiddenFields={[{ name: 'requestId', value: 'same-review' }, { name: 'tenantId', value: 'same-tenant' }]}
/>
