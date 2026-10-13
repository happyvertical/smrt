<script lang="ts">
/**
 * Record list widget (#3727): the rows a loader chose, each optionally a
 * link. The loader owns which field is the title and which records the viewer
 * may see; the widget only draws what it is given.
 *
 * With columns (the `columns` option, else the data's `columns`) the rows
 * render as a compact table of their `cells` (`RecordTable`): identifier,
 * status badge, date and amount by role, with a totals footer (on by
 * default when a money or quantity column exists; the `summaries` option
 * overrides). Without columns, the title list.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.overview.js';
import { safeHref } from '../markdown.js';
import type { WidgetComponentProps } from '../types.js';
import { isRecord, type RecordListWidgetData } from './data.js';
import RecordTable from './RecordTable.svelte';
import {
  isSummedRole,
  parseColumnsOption,
  readRecordRows,
  resolveRecordColumns,
} from './record-table.js';

let {
  data,
  locale,
  options,
  title,
}: WidgetComponentProps<RecordListWidgetData> = $props();

const { t } = useI18n();
const MAX_ROWS = 50;

interface Row {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  href: string | null;
}

const rows = $derived.by((): Row[] => {
  if (!isRecord(data) || !Array.isArray(data.rows)) return [];
  const out: Row[] = [];
  for (const row of data.rows.slice(0, MAX_ROWS)) {
    if (!isRecord(row) || typeof row.title !== 'string') continue;
    out.push({
      id: typeof row.id === 'string' ? row.id : String(out.length),
      title: row.title,
      subtitle: typeof row.subtitle === 'string' ? row.subtitle : undefined,
      meta: typeof row.meta === 'string' ? row.meta : undefined,
      href: typeof row.href === 'string' ? safeHref(row.href) : null,
    });
  }
  return out;
});
const total = $derived(
  isRecord(data) && typeof data.total === 'number' && data.total > rows.length
    ? data.total
    : null,
);
const viewAll = $derived(
  isRecord(data) && typeof data.href === 'string' ? safeHref(data.href) : null,
);

const columns = $derived(
  resolveRecordColumns(
    parseColumnsOption(options?.columns),
    isRecord(data) ? data.columns : undefined,
  ),
);
const tableRows = $derived(readRecordRows(data));
const showSummaries = $derived(
  typeof options?.summaries === 'boolean'
    ? options.summaries
    : columns.some((c) => isSummedRole(c.role)),
);
const dataTotal = $derived(
  isRecord(data) &&
    typeof data.total === 'number' &&
    Number.isFinite(data.total)
    ? data.total
    : null,
);
const summaryValues = $derived.by(() => {
  if (!isRecord(data) || !isRecord(data.summaries)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(data.summaries)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
});
</script>

{#if columns.length > 0 && tableRows.length > 0}
  <RecordTable
    rows={tableRows}
    {columns}
    {locale}
    label={title}
    currency={isRecord(data) && typeof data.currency === 'string' ? data.currency : undefined}
    timeZone={isRecord(data) && typeof data.timeZone === 'string' ? data.timeZone : undefined}
    summaries={showSummaries}
    {summaryValues}
    total={dataTotal}
  />
  {#if viewAll}
    <p class="smrt-records__foot smrt-records__foot--end" data-smrt-component="RecordListWidget">
      <a href={viewAll}>{t(M['ui.overview.records.view_all'])}</a>
    </p>
  {/if}
{:else if rows.length === 0}
  <p class="smrt-records__empty" data-smrt-component="RecordListWidget">{t(M['ui.overview.records.empty'])}</p>
{:else}
  <ul class="smrt-records" data-smrt-component="RecordListWidget">
    {#each rows as row (row.id)}
      <li class="smrt-records__row">
        <span class="smrt-records__main">
          {#if row.href}
            <a class="smrt-records__title" href={row.href}>{row.title}</a>
          {:else}
            <span class="smrt-records__title">{row.title}</span>
          {/if}
          {#if row.subtitle}<span class="smrt-records__sub">{row.subtitle}</span>{/if}
        </span>
        {#if row.meta}<span class="smrt-records__meta">{row.meta}</span>{/if}
      </li>
    {/each}
  </ul>
{/if}
{#if columns.length === 0 && (total !== null || viewAll)}
  <p class="smrt-records__foot" data-smrt-component="RecordListWidget">
    {#if total !== null}
      <span>{t(M['ui.overview.records.total'], { count: new Intl.NumberFormat(locale).format(total) })}</span>
    {/if}
    {#if viewAll}<a href={viewAll}>{t(M['ui.overview.records.view_all'])}</a>{/if}
  </p>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-records { display: grid; margin: 0; padding: 0; list-style: none; }
  .smrt-records__row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-2) 0; border-block-end: 1px solid var(--smrt-color-outline-variant); }
  .smrt-records__row:last-child { border-block-end: 0; }
  .smrt-records__main { display: grid; min-inline-size: 0; }
  .smrt-records__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--smrt-color-on-surface); font-weight: var(--smrt-typography-weight-medium, 500); text-decoration: none; }
  a.smrt-records__title:hover { text-decoration: underline; }
  .smrt-records__sub, .smrt-records__meta { color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-records__meta { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .smrt-records__foot { display: flex; justify-content: space-between; gap: var(--smrt-spacing-3); margin: var(--smrt-spacing-2) 0 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-records__foot--end { justify-content: flex-end; }
  .smrt-records__foot a { color: var(--smrt-color-primary); }
  .smrt-records__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
}
</style>
