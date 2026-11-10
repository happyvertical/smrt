<script lang="ts">
import { CurrencyDisplay } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { expenseMessages as M } from '../messages.js';
import type { ExpenseListProps } from '../types.js';
/** Caller-authorized costs for one exact cost object; no access policy runs here. */
export interface Props extends ExpenseListProps {}
let { expenses, costObjectType, costObjectId, title, message }: Props =
  $props();
const { t } = useI18n();
const rows = $derived(
  expenses.filter(
    (row) =>
      row.costObjectType === costObjectType &&
      row.costObjectId === costObjectId,
  ),
);
</script>
<section class="smrt-expense-list__root" aria-label={title ?? t(M['expenses.list.title'])} data-smrt-component="ExpenseList">
  <h2 data-smrt-part="title">{title ?? t(M['expenses.list.title'])}</h2>
  {#if message}<p role="alert">{message}</p>{/if}
  {#if rows.length === 0}<p data-smrt-part="empty">{t(M['expenses.list.empty'])}</p>{/if}
  <ul data-smrt-part="list">{#each rows as row (row.id)}
    <li data-smrt-part="row">
      {#if row.href}<a href={row.href}>{row.description}</a>{:else}<strong>{row.description}</strong>{/if}
      <p><CurrencyDisplay amount={row.amount} currency={row.currency} unit="cents" /> · {row.incurredOn}</p>
      <p>{row.statusLabel}</p>
      {#if row.note}<p>{row.note}</p>{/if}
    </li>
  {/each}</ul>
</section>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-expense-list__root, ul, li {
    display: grid;
    gap: var(--smrt-spacing-3);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  h2, p, ul {
    margin: 0;
  }
}

@layer smrt.theme {
}

</style>
