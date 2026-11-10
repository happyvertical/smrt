<script lang="ts">
/**
 * Line items widget (#3718 record page): a document's lines as a table
 * (item, quantity, unit price, amount) with a footer, then the totals block
 * aligned under the amounts: subtotal, discount and tax when present, total.
 * The record's own figures are shown as they are; a missing one is computed
 * from the lines and says so; when the record and the lines disagree, a
 * visible flag says what the lines add up to (`lineItemTotals`).
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.overview.js';
import { safeHref } from '../markdown.js';
import type { WidgetComponentProps } from '../types.js';
import { isRecord, type LineItemsWidgetData } from './data.js';
import {
  groupStoredTaxComponents,
  isStoredLineItemsTotals,
  lineItemTotals,
  sumLineAmounts,
  taxComponentLabel,
} from './line-totals.js';
import RecordTable from './RecordTable.svelte';
import {
  formatRecordCell,
  readRecordRows,
  resolveRecordColumns,
} from './record-table.js';

let { data, locale, title }: WidgetComponentProps<LineItemsWidgetData> =
  $props();

const { t } = useI18n();

const rows = $derived(readRecordRows(data));
const columns = $derived(
  resolveRecordColumns([], isRecord(data) ? data.columns : undefined),
);
const total = $derived(
  isRecord(data) &&
    typeof data.total === 'number' &&
    Number.isFinite(data.total)
    ? data.total
    : rows.length,
);
const currency = $derived(
  isRecord(data) && typeof data.currency === 'string'
    ? data.currency
    : undefined,
);
const summaryValues = $derived.by(() => {
  if (!isRecord(data) || !isRecord(data.summaries)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(data.summaries)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
});
/** The line amount column: the last money column that is summed. */
const amountKey = $derived(
  [...columns]
    .reverse()
    .find((c) => c.role === 'money' && c.summarize !== false)?.key,
);
const lineSum = $derived.by((): number | null => {
  if (!amountKey) return null;
  const hosted = summaryValues?.[amountKey];
  if (typeof hosted === 'number') return hosted;
  if (total > rows.length) return null;
  return sumLineAmounts(rows.map((row) => row.cells?.[amountKey]));
});
const result = $derived(
  lineItemTotals(
    isRecord(data) && isRecord(data.totals)
      ? (data.totals as LineItemsWidgetData['totals'])
      : undefined,
    lineSum,
  ),
);
const storedTotals = $derived(
  isRecord(data) && isStoredLineItemsTotals(data.storedTotals)
    ? data.storedTotals
    : undefined,
);
const storedTaxes = $derived(
  storedTotals
    ? groupStoredTaxComponents(storedTotals.taxes).filter(
        (tax) => tax.tax !== 0,
      )
    : [],
);
const hasStoredTax = $derived(storedTaxes.length > 0);
const viewAll = $derived(
  isRecord(data) && typeof data.href === 'string' ? safeHref(data.href) : null,
);

function money(value: number): string {
  return formatRecordCell({ role: 'money' }, value, { currency, locale });
}

const LABELS = {
  subtotal: M['ui.overview.line_items.subtotal'],
  discount: M['ui.overview.line_items.discount'],
  tax: M['ui.overview.line_items.tax'],
  total: M['ui.overview.line_items.total'],
} as const;
</script>

<div class="smrt-line-items" data-smrt-component="LineItemsWidget">
  {#if rows.length > 0 && columns.length > 0}
    <RecordTable
      {rows}
      {columns}
      {locale}
      label={title}
      {currency}
      summaries
      {summaryValues}
      {total}
    />
  {:else}
    <p class="smrt-line-items__empty">{t(M['ui.overview.line_items.empty'])}</p>
  {/if}
  {#if storedTotals}
    <dl class="smrt-line-items__totals" data-money-snapshot="stored">
      {#if storedTotals.lineAmountType !== 'inclusive' || !hasStoredTax}
        <div class="smrt-line-items__total"><dt>{t(M['ui.overview.line_items.subtotal'])}</dt><dd>{money(storedTotals.subtotal)}</dd></div>
      {/if}
      {#if storedTotals.discount !== 0}
        <div class="smrt-line-items__total smrt-line-items__total--muted"><dt>{t(M['ui.overview.line_items.discount_included'])} {money(Math.abs(storedTotals.discount))}</dt></div>
      {/if}
      {#each storedTaxes as tax (`${tax.taxComponentId}-${tax.name}-${tax.percent}`)}
        <div class="smrt-line-items__total smrt-line-items__total--muted">
          <dt>{t(M[storedTotals.lineAmountType === 'inclusive' ? 'ui.overview.line_items.tax_included' : 'ui.overview.line_items.tax_on'], { label: taxComponentLabel(tax.name, tax.percent) })} {money(storedTotals.lineAmountType === 'inclusive' ? tax.tax : tax.taxable)}</dt>
          {#if storedTotals.lineAmountType !== 'inclusive'}<dd>{money(tax.tax)}</dd>{/if}
        </div>
      {/each}
      {#if storedTotals.roundingScope === 'document'}
        <div class="smrt-line-items__total smrt-line-items__total--muted"><dt>{t(M['ui.overview.line_items.rounded_document'])}</dt></div>
      {/if}
      <div class="smrt-line-items__total smrt-line-items__total--grand"><dt>{t(M['ui.overview.line_items.total'])}</dt><dd>{money(storedTotals.total)}</dd></div>
      {#if storedTotals.lineAmountType === 'inclusive' && hasStoredTax && storedTotals.showNetSubtotal}
        <div class="smrt-line-items__total"><dt>{t(M['ui.overview.line_items.subtotal_excluding_tax'])}</dt><dd>{money(storedTotals.subtotal)}</dd></div>
      {/if}
    </dl>
  {:else if result.lines.length > 0}
    <dl class="smrt-line-items__totals">
      {#each result.lines as line (line.key)}
        {#if line.included}
        <div class="smrt-line-items__total smrt-line-items__total--muted"><dt>{t(M['ui.overview.line_items.discount_included'])} {money(Math.abs(line.value))}</dt></div>
        {:else}
        <div class="smrt-line-items__total" class:smrt-line-items__total--grand={line.key === 'total'}>
          <dt>
            {t(LABELS[line.key])}
            {#if line.computed}<span class="smrt-line-items__computed">{t(M['ui.overview.line_items.computed'])}</span>{/if}
          </dt>
          <dd>{line.key === 'discount' ? `−${money(line.value)}` : money(line.value)}</dd>
        </div>
        {/if}
      {/each}
    </dl>
  {/if}
  {#if !storedTotals && result.mismatch}
    <p class="smrt-line-items__flag">
      <strong>{t(M['ui.overview.line_items.mismatch'], { amount: money(result.mismatch.lines) })}</strong>
      {t(M[result.mismatch.field === 'subtotal' ? 'ui.overview.line_items.mismatch_subtotal' : 'ui.overview.line_items.mismatch_total'], { amount: money(result.mismatch.recorded) })}
    </p>
  {/if}
  {#if viewAll}
    <p class="smrt-line-items__foot"><a href={viewAll}>{t(M['ui.overview.records.view_all'])}</a></p>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-line-items { display: grid; gap: var(--smrt-spacing-3); min-inline-size: 0; }
  .smrt-line-items__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
  .smrt-line-items__totals { display: grid; justify-self: end; gap: var(--smrt-spacing-1); min-inline-size: min(100%, 18rem); margin: 0; font-variant-numeric: tabular-nums; }
  .smrt-line-items__total { display: flex; justify-content: space-between; gap: var(--smrt-spacing-4); }
  .smrt-line-items__total dt { color: var(--smrt-color-on-surface-variant); }
  .smrt-line-items__total--muted { color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size); }
  .smrt-line-items__total dd { margin: 0; text-align: end; }
  .smrt-line-items__total--grand { padding-block-start: var(--smrt-spacing-2); border-block-start: var(--smrt-hairline); font-weight: var(--smrt-typography-weight-semibold); }
  .smrt-line-items__total--grand dt { color: var(--smrt-color-on-surface); }
  .smrt-line-items__computed { margin-inline-start: var(--smrt-spacing-1); font-size: var(--smrt-typography-body-small-size, 0.75rem); }
  .smrt-line-items__flag { margin: 0; padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border-inline-start: var(--smrt-spacing-1) solid var(--smrt-color-warning); border-radius: var(--smrt-radius-sm); background: var(--smrt-color-warning-container); color: var(--smrt-color-on-warning-container); }
  .smrt-line-items__foot { display: flex; justify-content: flex-end; margin: 0; }
  .smrt-line-items__foot a { color: var(--smrt-color-primary); }
}
</style>
