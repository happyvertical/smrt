<script lang="ts">
import { onMount } from 'svelte';
import {
  IMPORT_PREVIEW_MAX,
  IMPORT_PREVIEW_ROWS,
  previewCell,
  previewType,
} from '$lib/ui/import';
import type { PublishDataTable } from '$lib/ui/publish';

let { table }: { table: PublishDataTable } = $props();
let rows = $state<Record<string, unknown>[]>([]);
let expanded = $state(false);

// Draft rows come through the existing records route, as the import review does.
async function read(limit: number) {
  try {
    const response = await fetch(
      `/api/shell/records/${encodeURIComponent(table.model)}?target=draft&limit=${limit}`,
    );
    if (!response.ok) return;
    const body = await response.json();
    if (Array.isArray(body.records)) rows = body.records;
  } catch {
    // The preview is optional; the counts above stand without it.
  }
}
onMount(() => void read(IMPORT_PREVIEW_ROWS));
const total = $derived(Math.max(table.inserted, rows.length));
const shown = $derived(expanded ? rows : rows.slice(0, IMPORT_PREVIEW_ROWS));
async function showAll() {
  expanded = true;
  await read(IMPORT_PREVIEW_MAX);
}
</script>
<div data-smrt-part="data-table">
  <h4>{table.label}</h4>
  <p>{table.sentence}</p>
  {#if rows.length && table.columns.length}
    <div class="smrt-app-shell__tablewrap" data-smrt-part="body">
      <table class="smrt-app-shell__table" data-smrt-part="table" aria-label="{table.label} row preview">
        <thead><tr>{#each table.columns as column (column.key)}<th scope="col">{column.label}<br /><small data-smrt-part="hint">{previewType(column.field)}</small></th>{/each}</tr></thead>
        <tbody>{#each shown as row, index (row.id ?? index)}<tr>{#each table.columns as column (column.key)}<td>{previewCell(row[column.key], column.field)}</td>{/each}</tr>{/each}</tbody>
      </table>
    </div>
    <p data-smrt-part="hint">Showing {shown.length} of {total} rows
      {#if !expanded && total > shown.length} · <button type="button" onclick={showAll}>Show all {total} rows</button>{/if}
      {#if expanded && total > IMPORT_PREVIEW_MAX} · The first {IMPORT_PREVIEW_MAX} are shown{/if}</p>
  {/if}
</div>
