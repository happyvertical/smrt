<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { invalidate } from '$app/navigation';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
import {
  ApiError,
  isPendingApproval,
  undoLast,
  undoPublish,
} from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import { fullTime, timeAgo } from '$lib/ui/format';
import { groupHistory, type HistoryGroup } from '$lib/ui/publish';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const groups = $derived(groupHistory(data.versions));
let selected = $state<HistoryGroup | null>(null);
const current = $derived(data.versions.find((v) => v.current));
const canUndo = $derived(!!current && current.parent !== null);
let confirming = $state(false);
let busy = $state(false);
let error = $state('');
let status = $state('');
/** Set when the undo is waiting for the owner's approval instead of applied. */
let waiting = $state(false);

async function undo() {
  busy = true;
  error = '';
  try {
    const target = data.description?.mode ?? 'live';
    const { data: out } =
      selected?.before !== null && selected?.before !== undefined
        ? await undoPublish(selected.before, target)
        : await undoLast(target);
    confirming = false;
    if (isPendingApproval(out)) {
      // Going back would overwrite newer values: nothing has changed yet.
      waiting = true;
      status = 'Waiting for your approval before this is undone.';
      return;
    }
    waiting = false;
    status = `Undone: ${out.summary}`;
    await Promise.all([
      invalidate(DEPENDS.history),
      invalidate(DEPENDS.shell),
      invalidate(DEPENDS.records),
    ]);
  } catch (e) {
    error = e instanceof ApiError ? e.message : 'Could not undo.';
  } finally {
    busy = false;
  }
}
</script>

<svelte:head><title>History</title></svelte:head>

<div class="sh-page">
  <header class="sh-head">
    <div>
      <h1>History</h1>
      <p class="sh-sub">Every change to your app, newest first.</p>
    </div>
  </header>

  <p class="sr-only" role="status" aria-live="polite">{status}</p>
  {#if status}
    <p class="sh-alert sh-alert-ok">
      {status}
      {#if waiting}<a href="/approvals">Review it on the approvals page</a>.{/if}
    </p>
  {/if}

  {#if data.versions.length === 0}
    <div class="sh-empty">
      <p><strong>No changes yet</strong></p>
      <p class="sh-muted">Changes to your app will be listed here, and you can undo the latest one.</p>
    </div>
  {:else}
    <ol class="sh-list">
      {#each groups as group (group.id)}
        <li>
          {#if group.name}
            <h2>{group.name}</h2>
            {#if group.canUndo}
              <Button variant="secondary" onclick={() => { selected = group; error = ''; confirming = true; }}>Undo this publish</Button>
            {/if}
          {/if}
          {#each group.versions as v (v.version)}
          <article class="sh-card" aria-current={v.current ? 'true' : undefined}>
            <div class="row">
              <h2>{v.summary || `Version ${v.version}`}</h2>
              <div class="badges">
                {#if v.current}<span class="sh-badge sh-badge-ok">Current</span>{/if}
                {#if v.purged}<span class="sh-badge sh-badge-warn">Cannot be undone</span>{/if}
              </div>
            </div>
            <p class="sh-muted">
              Version {v.version}{#if v.author}
                · by {v.author}{/if}
              ·
              <time datetime={v.createdAt} title={fullTime(v.createdAt)}
                >{timeAgo(v.createdAt)}</time
              >
            </p>
            {#if v.purged}
              <p class="sh-muted">
                Its saved data was cleaned up, so going back past this change is no longer possible.
              </p>
            {/if}
            {#if !group.name && v.current && canUndo}
              <button
                type="button"
                class="sh-btn"
                onclick={() => {
                  selected = null;
                  error = '';
                  confirming = true;
                }}
              >
                Undo this change
              </button>
            {/if}
          </article>
          {/each}
        </li>
      {/each}
    </ol>
  {/if}
</div>

<ConfirmDialog
  open={confirming}
  title={selected ? 'Undo this publish?' : 'Undo this change?'}
  confirmLabel="Undo"
  {busy}
  {error}
  onconfirm={undo}
  oncancel={() => (confirming = false)}
>
  <p>
    <strong>{selected?.name ?? current?.summary}</strong> will be taken back and your app returns
    to the version before it. Later changes are also taken back. Archived data is restored.
  </p>
</ConfirmDialog>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
  }
  .badges {
    display: flex;
    gap: var(--smrt-spacing-sm);
  }
  .sh-card p {
    margin: var(--smrt-spacing-sm, 0.5rem) 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
