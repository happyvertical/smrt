<script lang="ts">
import { untrack } from 'svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
let maxCells = $state(untrack(() => data.maxCells));
let message = $state('');
let busy = $state(false);
async function save(event: SubmitEvent) {
  event.preventDefault();
  busy = true;
  message = '';
  try {
    const response = await fetch('/api/shell/import/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxCells }),
    });
    const body = await response.json();
    message = response.ok
      ? 'Import limit saved.'
      : (body.error ?? 'The setting could not be saved.');
  } catch {
    message = 'The setting could not be saved. Please try again.';
  } finally {
    busy = false;
  }
}
</script>
<svelte:head><title>Import settings</title></svelte:head>
<div class="smrt-app-shell__page" data-smrt-component="AppShellImportSettings">
  <header class="smrt-app-shell__head" data-smrt-part="header"><h1>Import settings</h1></header>
  <form onsubmit={save} class="smrt-app-shell__card" data-smrt-part="panel">
    <label>Maximum cells in a workbook <input type="number" min="1000" max="2000000" step="1" required bind:value={maxCells} /></label>
    <p>A cell is one box in the spreadsheet. The provisional default is 250,000. Choose a whole number from 1,000 to 2,000,000. The file size limit remains 25 MiB.</p>
    <button class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={busy}>Save import limit</button>
    {#if message}<p role="status">{message}</p>{/if}
  </form>
</div>
