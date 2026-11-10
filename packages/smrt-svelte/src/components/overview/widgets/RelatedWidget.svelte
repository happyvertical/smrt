<script lang="ts">
/**
 * Related widget (#3718 record page): one tab per `children` relation, the
 * tab label carrying the count ("Orders 6"), each tab a records table with
 * role-chosen columns and a totals footer (`RecordTable`), and that tab's
 * one "View all". Relations with no records are hidden; when every one is
 * empty the widget says so once.
 */
import { Tabs } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.overview.js';
import { safeHref } from '../markdown.js';
import type { WidgetComponentProps } from '../types.js';
import { isRecord, type RelatedWidgetData } from './data.js';
import RecordTable from './RecordTable.svelte';
import { readRecordRows, resolveRecordColumns } from './record-table.js';

let { data, locale, title }: WidgetComponentProps<RelatedWidgetData> = $props();

const { t } = useI18n();

const tabs = $derived.by(() => {
  if (!isRecord(data) || !Array.isArray(data.tabs)) return [];
  const out = [];
  for (const tab of data.tabs) {
    if (!isRecord(tab) || typeof tab.key !== 'string') continue;
    const rows = readRecordRows(tab);
    const total =
      typeof tab.total === 'number' && Number.isFinite(tab.total)
        ? tab.total
        : rows.length;
    if (rows.length === 0 || total === 0) continue;
    const columns = resolveRecordColumns([], tab.columns);
    const summaries: Record<string, number> = {};
    if (isRecord(tab.summaries)) {
      for (const [key, value] of Object.entries(tab.summaries)) {
        if (typeof value === 'number' && Number.isFinite(value))
          summaries[key] = value;
      }
    }
    out.push({
      key: tab.key,
      label: typeof tab.label === 'string' ? tab.label : tab.key,
      rows,
      total,
      columns,
      href: typeof tab.href === 'string' ? safeHref(tab.href) : null,
      currency: typeof tab.currency === 'string' ? tab.currency : undefined,
      timeZone: typeof tab.timeZone === 'string' ? tab.timeZone : undefined,
      summaries,
    });
  }
  return out;
});

let selected = $state<string | null>(null);
const current = $derived(tabs.find((tab) => tab.key === selected) ?? tabs[0]);
</script>

{#if !current}
  <p class="smrt-related__empty" data-smrt-component="RelatedWidget">{t(M['ui.overview.related.empty'])}</p>
{:else}
  <div class="smrt-related" data-smrt-component="RelatedWidget">
    <Tabs
      tabs={tabs.map((tab) => ({ id: tab.key, label: tab.label, count: tab.total }))}
      active={current.key}
      onchange={(id) => (selected = id)}
      size="sm"
      variant="secondary"
      aria-label={title}
    >
      {#key current.key}
        {#if current.columns.length > 0}
          <RecordTable
            rows={current.rows}
            columns={current.columns}
            {locale}
            label={current.label}
            currency={current.currency}
            timeZone={current.timeZone}
            summaries
            summaryValues={current.summaries}
            total={current.total}
          />
        {:else}
          <ul class="smrt-related__list">
            {#each current.rows as row (row.id)}
              <li>
                {#if row.href && safeHref(row.href)}
                  <a href={safeHref(row.href)}>{row.title}</a>
                {:else}
                  {row.title}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        {#if current.href}
          <p class="smrt-related__foot">
            <a href={current.href}>{t(M['ui.overview.records.view_all'])}</a>
          </p>
        {/if}
      {/key}
    </Tabs>
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-related { min-inline-size: 0; }
  .smrt-related__list { display: grid; gap: var(--smrt-spacing-2); margin: var(--smrt-spacing-2) 0 0; padding: 0; list-style: none; }
  .smrt-related__foot { display: flex; justify-content: flex-end; margin: var(--smrt-spacing-2) 0 0; font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-related__foot a { color: var(--smrt-color-primary); }
  .smrt-related__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
}
</style>
