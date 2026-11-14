<script lang="ts">
import { invalidate } from '$app/navigation';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
import { ApiError, api, isPendingApproval } from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import { reportApi, reportHref } from '$lib/ui/reports';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
let selected = $state<string | null>(null);
let renaming = $state<string | null>(null);
let to = $state('');
let busy = $state(false);
let problem = $state('');
let waiting = $state(false);
async function change(name: string, action: 'rename' | 'remove') {
  busy = true;
  problem = '';
  waiting = false;
  try {
    const { data: out } = await api(reportApi(name), {
      method: 'POST',
      body: { action, ...(action === 'rename' ? { label: to } : {}) },
      target: data.target,
    });
    waiting = isPendingApproval(out);
    selected = null;
    renaming = null;
    await Promise.all([invalidate(DEPENDS.shell), invalidate(DEPENDS.history)]);
  } catch (e) {
    problem =
      e instanceof ApiError ? e.message : 'Could not change this report.';
  } finally {
    busy = false;
  }
}
</script>
<svelte:head><title>Reports</title></svelte:head>
<div class="smrt-app-shell__page">
  <header class="smrt-app-shell__head"><h1>Reports</h1></header>
  <p class="smrt-app-shell__sub">Ask the assistant to make or change a report. Run a report here to see the latest answers.</p>
  {#if problem}<p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert">{problem}</p>{/if}
  {#if waiting}<p class="smrt-app-shell__alert" role="status">Waiting for your approval. <a href="/approvals">Review the change</a>.</p>{/if}
  {#if Object.keys(data.description?.reports ?? {}).length === 0}<p class="smrt-app-shell__empty">No reports yet. Ask the assistant for a total or a breakdown.</p>{/if}
  <ul class="smrt-app-shell__list">
    {#each Object.entries(data.description?.reports ?? {}) as [name, report] (name)}
      <li class="smrt-app-shell__card"><h2><a href={reportHref(name)}>{report.label ?? report.spec.title}</a></h2><p>{report.description ?? report.spec.description ?? ''}</p><p class="smrt-app-shell__muted">Source: {data.description?.models[report.spec.source]?.label ?? 'Removed model'}</p>
        <div class="smrt-app-shell__actions"><a class="smrt-app-shell__btn" href={reportHref(name)}>Run report</a><button class="smrt-app-shell__btn" onclick={() => { renaming = name; to = report.label ?? report.spec.title; problem = ''; }}>Rename</button><button class="smrt-app-shell__btn smrt-app-shell__btn-danger" onclick={() => { selected = name; problem = ''; }}>Remove</button></div>
        {#if renaming === name}<form onsubmit={(e) => { e.preventDefault(); void change(name, 'rename'); }}><label class="smrt-app-shell__label">Report label<input class="smrt-app-shell__input" bind:value={to} required /></label><div class="smrt-app-shell__actions"><button class="smrt-app-shell__btn" disabled={busy}>Save label</button><button type="button" class="smrt-app-shell__btn" onclick={() => (renaming = null)}>Cancel</button></div></form>{/if}
      </li>
    {/each}
  </ul>
</div>
<ConfirmDialog open={selected !== null} title="Remove this report?" confirmLabel="Remove report" danger {busy} onconfirm={() => selected && change(selected, 'remove')} oncancel={() => (selected = null)}><p>Remove the saved report definition? The source records stay in your app.</p></ConfirmDialog>
