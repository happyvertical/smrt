<script lang="ts">
import { onMount, untrack } from 'svelte';
import ImportReview from '$lib/components/ImportReview.svelte';
import { IMPORT_MAX_BYTES } from '$lib/import-limits';
import { type ImportState, importStages } from '$lib/ui/import';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
let current = $state<ImportState | null>(untrack(() => data.current));
let error = $state('');
let busy = $state(false);
let reading = $state(false);
let dragging = $state(false);
const active = $derived(
  current &&
    ['running', 'stopped'].includes(current.state) &&
    !['discarded', 'published', 'cancelled'].includes(current.status),
);
const review = $derived(current?.status === 'review');
async function refresh() {
  const response = await fetch('/api/shell/import');
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error ?? 'The import status could not be read.');
  current = body.import;
}
onMount(() => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      await refresh();
    } catch {
      if (!stopped)
        error =
          'The import status could not be read. Check your connection and refresh.';
    }
    if (!stopped) timer = setTimeout(poll, 1000);
  };
  timer = setTimeout(poll, 1000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
});
async function upload(file: File | undefined) {
  if (!file || busy) return;
  error = '';
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    error = 'Choose an Excel workbook saved as .xlsx.';
    return;
  }
  if (file.size > IMPORT_MAX_BYTES) {
    error =
      'This workbook is larger than 25 MiB. Save a smaller workbook and try again.';
    return;
  }
  busy = true;
  reading = true;
  try {
    const response = await fetch('/api/shell/import', {
      method: 'POST',
      headers: {
        'content-type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      body: file,
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error ?? 'The import could not start.');
    await refresh();
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'The import could not start. Please try again.';
  } finally {
    busy = false;
    reading = false;
  }
}
async function action(name: string) {
  busy = true;
  error = '';
  try {
    const response = await fetch(`/api/shell/import/${name}`, {
      method: 'POST',
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error ?? 'The import could not be changed.');
    await refresh();
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'The import could not be changed.';
  } finally {
    busy = false;
  }
}
</script>
<svelte:head><title>Import a workbook</title></svelte:head>
<div class="smrt-app-shell__page" data-smrt-component="AppShellImport">
  <header class="smrt-app-shell__head" data-smrt-part="header"><h1>Import a workbook</h1></header>
  <p>Load an Excel workbook into a draft. Check the proof, then review and publish it.</p>
  {#if error}<p class="smrt-app-shell__alert smrt-app-shell__alert-warn" role="alert" data-smrt-part="status">{error}</p>{/if}
  {#if reading}<p role="status">Reading the workbook</p>{/if}
  {#if active || review}
    <p role="status">{current?.state === 'stopped' ? 'Import paused' : importStages[current?.step ?? ''] ?? 'Preparing the import'}</p>
    {#if current?.state === 'stopped'}<p>{current.stopReason?.startsWith('max_') ? 'This import reached its work budget. Resume gives it another bounded allowance; you can also discard it and try a smaller workbook.' : 'Your progress is saved. Resume to continue.'}</p>{/if}
    {#if review}
      <p>The workbook passed its proof. Publishing still needs your approval on the draft review screen.</p>
      <a class="smrt-app-shell__btn smrt-app-shell__btn-primary" href="/draft/review" data-smrt-part="trigger">Review and publish</a>
      <button class="smrt-app-shell__btn" disabled={busy} onclick={() => action('discard')}>Discard import</button>
    {:else}
      <button class="smrt-app-shell__btn" disabled={busy} onclick={() => action(current?.state === 'stopped' ? 'resume' : 'stop')}>{current?.state === 'stopped' ? 'Resume import' : 'Stop'}</button>
      <button class="smrt-app-shell__btn" disabled={busy} onclick={() => action('cancel')}>Cancel import</button>
    {/if}
  {:else}
    {#if current}
      <p role="status">{importStages[current.status] ?? 'The import could not finish'}</p>
      {#if current.note}<p>{current.note}</p>{/if}
      {#if current.status === 'failed'}<p>Correct the workbook using the findings below, then choose the corrected file.</p>{/if}
    {/if}
    <section class="smrt-app-shell__card" data-smrt-part="panel" aria-label="Workbook drop zone"
      ondragover={(event) => { event.preventDefault(); dragging = true; }} ondragleave={() => { dragging = false; }}
      ondrop={(event) => { event.preventDefault(); dragging = false; void upload(event.dataTransfer?.files[0]); }}>
      <p>{dragging ? 'Drop your workbook here' : 'Drop an .xlsx workbook here, or choose a file.'}</p>
      <label>Choose a workbook <input aria-label="Choose a workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onchange={(event) => { void upload(event.currentTarget.files?.[0]); }} /></label>
      <p>Up to 25 MiB. The cell limit is adjustable in <a href="/settings/import">Import settings</a>.</p>
    </section>
  {/if}
  {#if current}<ImportReview {current} />{/if}
</div>
