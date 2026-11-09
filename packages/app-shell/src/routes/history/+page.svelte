<script lang="ts">
import { invalidate } from '$app/navigation';
import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
import { ApiError, undoLast } from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import { fullTime, timeAgo } from '$lib/ui/format';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const current = $derived(data.versions.find((v) => v.current));
const canUndo = $derived(!!current && current.parent !== null);
let confirming = $state(false);
let busy = $state(false);
let error = $state('');
let status = $state('');

async function undo() {
  busy = true;
  error = '';
  try {
    const { data: out } = await undoLast();
    confirming = false;
    status = `Undone: ${out.summary}`;
    await Promise.all([
      invalidate(DEPENDS.history),
      invalidate(DEPENDS.shell),
      invalidate(DEPENDS.records),
    ]);
  } catch (e) {
    error =
      e instanceof ApiError && e.status === 409
        ? `${e.message}. Cleaned-up changes cannot be undone.`
        : e instanceof ApiError
          ? e.message
          : 'Could not undo.';
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
  {#if status}<p class="sh-alert sh-alert-ok">{status}</p>{/if}

  {#if data.versions.length === 0}
    <div class="sh-empty">
      <p><strong>No changes yet</strong></p>
      <p class="sh-muted">Changes to your app will be listed here, and you can undo the latest one.</p>
    </div>
  {:else}
    <ol class="sh-list">
      {#each data.versions as v (v.version)}
        <li>
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
            {#if v.current && canUndo}
              <button
                type="button"
                class="sh-btn"
                onclick={() => {
                  error = '';
                  confirming = true;
                }}
              >
                Undo this change
              </button>
            {/if}
          </article>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<ConfirmDialog
  open={confirming}
  title="Undo this change?"
  confirmLabel="Undo"
  {busy}
  {error}
  onconfirm={undo}
  oncancel={() => (confirming = false)}
>
  <p>
    <strong>{current?.summary}</strong> will be taken back and your app returns
    to the version before it. Data archived by the change is restored.
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
    gap: 0.4rem;
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
