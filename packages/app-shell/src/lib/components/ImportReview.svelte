<script lang="ts">
import { columnName } from '@happyvertical/spreadsheets';
import {
  fieldLabel,
  findingLabel,
  type ImportState,
  importTotal,
} from '../ui/import.ts';

let { current }: { current: ImportState } = $props();
</script>
<div data-smrt-component="AppShellImportReview" class="smrt-app-shell__page">
  {#each current.plan?.tables ?? [] as table (table.key)}
    {@const facts = current.proof?.facts.tables[table.key]}
    <section class="smrt-app-shell__card" data-smrt-part="panel" aria-label={table.label}>
      <h2>{table.label}</h2>
      <p>{table.source.sheet} · {table.source.range}</p>
      {#if facts}<p>{facts.read} rows read · {facts.skipped} skipped · {current.proof?.loaded[table.key] ?? 0} loaded</p>{/if}
      <ul data-smrt-part="list">
        {#each table.fields as field (field.key)}
          <li><strong>{field.label}</strong> · {field.type === 'reference' ? 'link' : field.type === 'integer' ? 'whole number' : field.type === 'boolean' ? 'yes or no' : field.type}
            {#if field.column} · column {columnName(field.column)}{/if}
            {#if field.money} · {field.money.currency}, {field.money.scale} decimal places{/if}
            {#if field.choices} · {field.choices.join(', ')}{/if}
            {#if field.reference} · links to {fieldLabel(current.plan, field.reference.table)}{/if}
            {#if field.calculated} · calculated
              {#if field.cachedColumn} · workbook result in column {columnName(field.cachedColumn)} · {current.proof?.ok ? 'matches the workbook' : 'not yet proven'}{/if}
            {/if}
          </li>
        {/each}
      </ul>
      {#if current.proof}
        <h3>Totals proof</h3>
        <p>{current.proof.ok ? 'Row counts and source column sums match the workbook.' : 'The loaded data did not pass every check.'}</p>
        <ul>{#each Object.entries(current.proof.facts.sums[table.key] ?? {}) as [field, total] (field)}
          <li>{fieldLabel(current.plan, table.key, field)}: {importTotal(total, table.fields.find((f) => f.key === field)?.money)}</li>
        {/each}</ul>
      {/if}
    </section>
  {/each}
  {#if current.plan?.reports?.length}
    <section class="smrt-app-shell__card" data-smrt-part="panel"><h2>Reports</h2><ul>{#each current.plan.reports as report (report.key)}<li>{report.label}</li>{/each}</ul></section>
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
