<script lang="ts">
import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { columnName } from '@happyvertical/spreadsheets';
import { formulaWords } from '../../engine/formula.ts';
import {
  fieldLabel,
  findingLabel,
  IMPORT_PREVIEW_MAX,
  IMPORT_PREVIEW_ROWS,
  type ImportState,
  importTotal,
  type LinkLabels,
  previewCell,
  previewType,
  readLinkLabels,
} from '../ui/import.ts';

let { current }: { current: ImportState } = $props();
// Loaded draft rows per table key, read through the existing draft records route.
let rows = $state<Record<string, Record<string, unknown>[]>>({});
let expanded = $state<Record<string, boolean>>({});
let labels = $state<LinkLabels>({});
let labelsRead = false;
async function read(key: string, limit: number) {
  const model = current.plan?.engineNames?.tables[key]?.model;
  if (!model) return;
  try {
    const response = await fetch(
      `/api/shell/records/${encodeURIComponent(model)}?target=draft&limit=${limit}`,
    );
    if (!response.ok) return;
    const body = await response.json();
    if (Array.isArray(body.records)) rows[key] = body.records;
  } catch {
    // The preview is optional; the proof above stands without it.
  }
}
const previewable = $derived(
  current.status === 'review' && current.proof?.ok === true,
);
$effect(() => {
  if (!previewable) return;
  const plan = current.plan;
  const names = plan?.engineNames?.tables;
  if (!labelsRead && plan?.tables.length) {
    labelsRead = true;
    void readLinkLabels(
      (plan?.tables ?? []).flatMap((table) => {
        const target = names?.[table.key];
        return target
          ? [
              {
                model: target.model,
                fields: Object.fromEntries(
                  table.fields.map((f) => [target.fields[f.key] ?? f.key, f]),
                ),
              },
            ]
          : [];
      }),
    ).then((found) => {
      labels = found;
    });
  }
  for (const table of current.plan?.tables ?? [])
    if (!rows[table.key]) void read(table.key, IMPORT_PREVIEW_ROWS);
});
/** Everything the column list used to say, now once under the column name. */
function columnHint(
  table: NonNullable<ImportState['plan']>['tables'][number],
  field: (typeof table.fields)[number],
): string {
  const parts = [previewType(field, current.plan)];
  if (field.column) parts.push(`column ${columnName(field.column)}`);
  if (field.choices) parts.push(field.choices.join(', '));
  if (field.calculated) {
    parts.push(
      `calculated: ${formulaWords(field.calculated as GeneratedExpression, Object.fromEntries(table.fields.map((f) => [f.key, f.label])))}`,
    );
    if (field.cachedColumn)
      parts.push(
        `workbook result in column ${columnName(field.cachedColumn)} · ${current.proof?.ok ? 'matches the workbook' : 'not yet proven'}`,
      );
  }
  return parts.join(' · ');
}
async function showAll(key: string) {
  expanded[key] = true;
  await read(key, IMPORT_PREVIEW_MAX);
}
</script>
<div data-smrt-component="AppShellImportReview" class="smrt-app-shell__page">
  {#each current.plan?.tables ?? [] as table (table.key)}
    {@const facts = current.proof?.facts.tables[table.key]}
    <section class="smrt-app-shell__card" data-smrt-part="panel" aria-label={table.label}>
      <h2>{table.label}</h2>
      <p>{table.source.sheet} · {table.source.range}</p>
      {#if facts}<p>{facts.read} rows read · {facts.skipped} skipped · {current.proof?.loaded[table.key] ?? 0} loaded</p>{/if}
      <p data-smrt-part="hint">{#if current.proof?.ok}<span>Totals match</span> · {/if}<span>{table.fields.length} {table.fields.length === 1 ? 'column' : 'columns'} detected</span></p>
      {#if table.fields.length}
        {@const names = current.plan?.engineNames?.tables[table.key]?.fields ?? {}}
        {@const have = rows[table.key] ?? []}
        {@const loaded = current.proof?.loaded[table.key] ?? have.length}
        {@const shown = expanded[table.key] ? have : have.slice(0, IMPORT_PREVIEW_ROWS)}
        <div class="smrt-app-shell__tablewrap" data-smrt-part="body">
          <table class="smrt-app-shell__table" data-smrt-part="table" aria-label="{table.label} row preview">
            <thead><tr>{#each table.fields as field (field.key)}<th scope="col">{field.label}<br /><small data-smrt-part="hint">{columnHint(table, field)}</small></th>{/each}</tr></thead>
            <tbody>{#each shown as row, index (row.id ?? index)}<tr>{#each table.fields as field (field.key)}<td>{previewCell(row[names[field.key]], field, field.reference ? labels[current.plan?.engineNames?.tables[field.reference.table]?.model ?? '']?.[String(row[names[field.key]])] : undefined)}</td>{/each}</tr>{/each}</tbody>
          </table>
        </div>
        {#if have.length}<p data-smrt-part="hint">Showing {shown.length} of {loaded} rows
          {#if !expanded[table.key] && loaded > shown.length} · <button type="button" onclick={() => showAll(table.key)}>Show all {loaded} rows</button>{/if}
          {#if expanded[table.key] && loaded > IMPORT_PREVIEW_MAX} · The first {IMPORT_PREVIEW_MAX} are shown{/if}</p>{/if}
      {/if}
      {#if current.proof}
        {@const totals = Object.entries(current.proof.facts.sums[table.key] ?? {}).flatMap(([field, total]) => {
          const definition = table.fields.find((f) => f.key === field);
          return definition && (definition.type !== 'integer' || /^(qty|quantity|units|count)$/.test(definition.key))
            ? [`${fieldLabel(current.plan, table.key, field)}: ${importTotal(total, definition.money)}`]
            : [];
        })}
        <p data-smrt-part="hint"><strong>Totals proof</strong> · {current.proof.ok ? 'Row counts and source column checks match the workbook.' : 'The loaded data did not pass every check.'}</p>
        {#if totals.length}<p data-smrt-part="hint">{totals.join(' · ')}</p>{/if}
      {/if}
    </section>
  {/each}
  {#if current.plan?.reports?.length}
    <section class="smrt-app-shell__card" data-smrt-part="panel"><h2>Reports</h2><ul>{#each current.plan.reports as report (report.key)}<li>{report.label}</li>{/each}</ul></section>
  {/if}
  {#if current.untranslatedFormulas?.length}
    <section class="smrt-app-shell__card" data-smrt-part="panel"><h2>Formulas not translated</h2>
      <p>These fields keep the workbook’s saved results. They will not recalculate when you change a record.</p>
      <ul>{#each current.untranslatedFormulas as entry (`${entry.table}:${entry.field}`)}<li>{entry.sheet} · {fieldLabel(current.plan, entry.table, entry.field)}, column {columnName(entry.column)} · {entry.count} {entry.count === 1 ? 'formula' : 'formulas'}
        <ul>{#each entry.examples as example (example.cell)}<li>{example.cell}: {example.formula}</li>{/each}</ul>
      </li>{/each}</ul>
    </section>
  {/if}
  {#if current.findings?.length}
    <section class="smrt-app-shell__card" data-smrt-part="panel"><h2>Findings</h2>
      <p>Up to 20 examples are shown for each check, table and field. Each example includes the total count.</p>
      <ul>{#each current.findings as finding, index (index)}
        <li>{findingLabel(finding)} · {fieldLabel(current.plan, finding.table)}{finding.field ? `, ${fieldLabel(current.plan, finding.table, finding.field)}` : ''}
          {#if finding.sheet} · {finding.sheet}{/if}{#if finding.cell} · {finding.cell}{/if} · {finding.count} {finding.count === 1 ? 'finding' : 'findings'}
          {#if finding.expected !== undefined} · expected {finding.expected ?? 'blank'}{/if}{#if finding.actual !== undefined} · found {finding.actual ?? 'blank'}{/if}
        </li>
      {/each}</ul>
    </section>
  {/if}
</div>
