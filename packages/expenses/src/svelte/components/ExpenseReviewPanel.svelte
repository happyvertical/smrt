<script lang="ts">
import { AttachmentPanel } from '@happyvertical/smrt-assets/svelte';
import { CurrencyDisplay } from '@happyvertical/smrt-ui';
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { expenseMessages as M } from '../messages.js';
import type { ExpenseReviewPanelProps } from '../types.js';
/** Server-authoritative expense review, duplicates/history and receipt composition. */
export interface Props extends ExpenseReviewPanelProps {}
let {
  expense,
  duplicates = [],
  history = [],
  receipts,
  canReview = false,
  action,
  actions = [],
  intentField = 'intent',
  hiddenFields = [],
  message,
  pending = false,
  children,
  onsubmit,
}: Props = $props();
const { t } = useI18n();
</script>
<section class="expense-review" aria-label={t(M['expenses.review.title'])}>
  <h3>{expense.description}</h3>
  <p><CurrencyDisplay amount={expense.amount} currency={expense.currency} unit="cents" /> · {expense.incurredOn}</p>
  <p aria-live="polite">{expense.statusLabel}</p>
  {#if expense.note}<p>{expense.note}</p>{/if}
  {#if message}<p role="alert">{message}</p>{/if}
  <section aria-label={t(M['expenses.review.duplicates'])}>
    <h4>{t(M['expenses.review.duplicates'])}</h4>
    {#if duplicates.length === 0}<p>{t(M['expenses.review.no_duplicates'])}</p>{/if}
    <ul>{#each duplicates as duplicate (duplicate.id)}<li><strong>{duplicate.label}</strong>{#if duplicate.reason}<p>{duplicate.reason}</p>{/if}</li>{/each}</ul>
  </section>
  <section aria-label={t(M['expenses.review.history'])}>
    <h4>{t(M['expenses.review.history'])}</h4>
    {#if history.length === 0}<p>{t(M['expenses.review.no_history'])}</p>{/if}
    <ol>{#each history as entry (entry.id)}<li><strong>{entry.label}</strong>{#if entry.detail}<p>{entry.detail}</p>{/if}</li>{/each}</ol>
  </section>
  {#if canReview && action && actions.length}
    <Form {action} method="post" preventDefault={false} {onsubmit} aria-busy={pending}>
      {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
      {@render children?.()}
      <div class="actions">{#each actions as choice}<Button type="submit" name={intentField} value={choice.intent} disabled={pending || choice.disabled}>{choice.label}</Button>{/each}</div>
    </Form>
  {/if}
  {#if receipts}<AttachmentPanel {...receipts} />{/if}
</section>
<style>
  .expense-review { display: grid; gap: var(--smrt-spacing-4); min-width: 0; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); }
  h3, h4, p { margin: 0; }
  ul, ol { display: grid; gap: var(--smrt-spacing-2); padding-inline-start: var(--smrt-spacing-5); }
</style>
