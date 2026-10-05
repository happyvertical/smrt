<script lang="ts">
import { CurrencyDisplay } from '@happyvertical/smrt-ui';
import { Form, FormGroup, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { expenseMessages as M } from '../messages.js';
import type { ExpenseReviewQueueProps } from '../types.js';
/** Explicit native review decisions; never infer capabilities from displayed status. */
export interface Props extends ExpenseReviewQueueProps {}
let {
  expenses,
  canReview = false,
  message,
  expenseField = 'expenseId',
  reasonField = 'reason',
  intentField = 'intent',
  approveIntent = 'approve',
  rejectIntent = 'reject',
}: Props = $props();
const { t } = useI18n();
const id = $props.id();
</script>
<section class="queue" aria-label={t(M['expenses.queue.title'])}>
  <h2>{t(M['expenses.queue.title'])}</h2>
  {#if message}<p role="alert">{message}</p>{/if}
  {#if !expenses.length}<p>{t(M['expenses.queue.empty'])}</p>{/if}
  {#each expenses as row, index (row.id)}
    <article aria-label={row.description}>
      <h3>{row.description}</h3>
      <p><CurrencyDisplay amount={row.amount} currency={row.currency} unit="cents" /> · {row.incurredOn}</p>
      <p>{row.statusLabel}</p>
      {#if row.note}<p>{row.note}</p>{/if}
      {#if row.message}<p role="alert">{row.message}</p>{/if}
      {#if canReview && row.canReview && row.action !== undefined}
        <Form action={row.action} method="post" preventDefault={false} aria-busy={row.pending}>
          <Input type="hidden" name={expenseField} value={row.id} interaction={false} />
          {#each row.hiddenFields ?? [] as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
          <FormGroup id={`reason-${id}-${index}`} label={t(M['expenses.queue.reason'])}>
            <Textarea name={reasonField} value={row.reason ?? ''} required disabled={row.pending} />
          </FormGroup>
          <div class="actions">
            <Button type="submit" name={intentField} value={approveIntent} formnovalidate disabled={row.pending}>{t(M['expenses.queue.approve'])}</Button>
            <Button type="submit" name={intentField} value={rejectIntent} disabled={row.pending}>{t(M['expenses.queue.reject'])}</Button>
          </div>
        </Form>
      {/if}
    </article>
  {/each}
</section>
<style>
  .queue, article { display: grid; gap: var(--smrt-spacing-3); min-width: 0; overflow-wrap: anywhere; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); }
  h2, h3, p { margin: 0; }
</style>
