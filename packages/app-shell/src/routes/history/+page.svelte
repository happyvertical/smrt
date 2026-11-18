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
import {
  groupHistory,
  type HistoryGroup,
  historyEntries,
} from '$lib/ui/publish';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const entries = $derived(historyEntries(groupHistory(data.versions)));
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
    status = `Undone: ${out.humanSummary ?? 'the selected change'}`;
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
      {#each entries as entry (entry.group.id)}
        {@const group = entry.group}
        <li>
          <article class="smrt-app-shell__card" aria-current={entry.current ? 'true' : undefined}>
            <div class="smrt-app-shell-history__row">
              <h2>{entry.title}</h2>
              <div class="smrt-app-shell-history__badges" data-smrt-part="badges">
                {#if entry.current}<span class="smrt-app-shell__badge smrt-app-shell__badge-ok" data-smrt-part="badge">Current</span>{/if}
                {#if entry.purged}<span class="smrt-app-shell__badge smrt-app-shell__badge-warn" data-smrt-part="badge">Cannot be undone</span>{/if}
              </div>
            </div>
            <p class="smrt-app-shell__muted" data-smrt-part="description">
              {#if entry.newest.author}{authorName(entry.newest.author, data.session?.user)}
                {' · '}{/if}<time datetime={entry.newest.createdAt} title={fullTime(entry.newest.createdAt)}
                >{timeAgo(entry.newest.createdAt)}</time
              >
            </p>
            {#if group.name && entry.changes.length}
              <details class="smrt-app-shell-history__changes" data-smrt-part="changes">
                <summary>{entry.changes.length === 1 ? '1 change' : `${entry.changes.length} changes`}</summary>
                <ul>
                  {#each entry.changes as change}<li>{change}</li>{/each}
                </ul>
              </details>
            {/if}
            {#if entry.purged}
              <p class="smrt-app-shell__muted" data-smrt-part="description">
                Its saved data was cleaned up, so going back past this change is no longer possible.
              </p>
            {/if}
            {#if group.name && group.canUndo}
              <Button variant="secondary" onclick={() => { selected = group; error = ''; confirming = true; }}>Undo this publish</Button>
            {:else if !group.name && entry.current && canUndo}
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
    <strong>{selected?.name ?? current?.humanSummary ?? 'Change to your app'}</strong> will be taken back and your app returns
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
  .smrt-app-shell-history__changes ul {
    margin: var(--smrt-spacing-sm, 0.5rem) 0 0;
    padding-left: var(--smrt-spacing-lg, 1.25rem);
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
