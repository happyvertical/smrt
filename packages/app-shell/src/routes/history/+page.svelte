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
import { authorName, fullTime, timeAgo } from '$lib/ui/format';
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

<div class="smrt-app-shell__page" data-smrt-component="AppShellHistory">
  <header class="smrt-app-shell__head" data-smrt-part="header">
    <div>
      <h1>History</h1>
      <p class="smrt-app-shell__sub" data-smrt-part="description">Every change to your app, newest first.</p>
    </div>
  </header>

  <p class="smrt-app-shell-history__sr-only" role="status" aria-live="polite" data-smrt-part="label">{status}</p>
  {#if status}
    <p class="smrt-app-shell__alert smrt-app-shell__alert-ok" data-smrt-part="status">
      {status}
      {#if waiting}<a href="/approvals">Review it on the approvals page</a>.{/if}
    </p>
  {/if}

  {#if data.versions.length === 0}
    <div class="smrt-app-shell__empty" data-smrt-part="empty">
      <p><strong>No changes yet</strong></p>
      <p class="smrt-app-shell__muted" data-smrt-part="description">Changes to your app will be listed here, and you can undo the latest one.</p>
    </div>
  {:else}
    <ol class="smrt-app-shell__list">
      {#each groups as group (group.id)}
        <li>
          {#if group.name}
            <h2>{group.name}</h2>
            {#if group.canUndo}
              <Button variant="secondary" onclick={() => { selected = group; error = ''; confirming = true; }}>Undo this publish</Button>
            {/if}
          {/if}
          {#each group.versions as v (v.version)}
          <article class="smrt-app-shell__card" aria-current={v.current ? 'true' : undefined}>
            <div class="smrt-app-shell-history__row">
              <h2>{v.summary || `Version ${v.version}`}</h2>
              <div class="smrt-app-shell-history__badges" data-smrt-part="badges">
                {#if v.current}<span class="smrt-app-shell__badge smrt-app-shell__badge-ok" data-smrt-part="badge">Current</span>{/if}
                {#if v.purged}<span class="smrt-app-shell__badge smrt-app-shell__badge-warn" data-smrt-part="badge">Cannot be undone</span>{/if}
              </div>
            </div>
            <p class="smrt-app-shell__muted" data-smrt-part="description">
              Version {v.version}{#if v.author}
                {' · by '}{authorName(v.author, data.session?.user)}{/if}
              ·
              <time datetime={v.createdAt} title={fullTime(v.createdAt)}
                >{timeAgo(v.createdAt)}</time
              >
            </p>
            {#if v.purged}
              <p class="smrt-app-shell__muted" data-smrt-part="description">
                Its saved data was cleaned up, so going back past this change is no longer possible.
              </p>
            {/if}
            {#if !group.name && v.current && canUndo}
              <button
                type="button"
                class="smrt-app-shell__btn"
                onclick={() => {
                  selected = null;
                  error = '';
                  confirming = true;
                }} data-smrt-part="trigger"
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

@layer smrt.structure {
  .smrt-app-shell-history__row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  h2 {
    margin: 0;
  }
  .smrt-app-shell-history__badges {
    display: flex;
    gap: var(--smrt-spacing-sm);
  }
  .smrt-app-shell__card p {
    margin: var(--smrt-spacing-sm, 0.5rem) 0;
  }
  .smrt-app-shell-history__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  h2 {
    font-size: 1.0625rem;
  }
}
</style>
