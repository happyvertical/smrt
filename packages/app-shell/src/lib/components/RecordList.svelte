<script lang="ts">
import { invalidate } from '$app/navigation';
import { ApiError, records as api, isPendingApproval } from '$lib/ui/api';
import {
  cellText,
  indexReferences,
  orderByCreated,
  selectColumns,
} from '$lib/ui/columns';
import { DEPENDS } from '$lib/ui/events';
import { recordLabel } from '$lib/ui/fields';
import { modelHref } from '$lib/ui/menu';
import type { Description, PendingApproval, RecordRow } from '$lib/ui/types';
import ConfirmDialog from './ConfirmDialog.svelte';
import MethodRunner from './MethodRunner.svelte';

interface Props {
  model: string;
  description: Description;
  rows: RecordRow[];
  /** Records of referenced models, to show their labels. */
  references?: Record<string, RecordRow[]>;
}

let { model, description, rows, references = {} }: Props = $props();

const info = $derived(description.models[model]);
const columns = $derived(selectColumns(info));
let sortField = $state<string | null>(null);
let descending = $state(false);
const sorted = $derived.by(() => {
  const ordered = orderByCreated(rows);
  if (!sortField) return ordered;
  const field = sortField;
  return ordered.sort((a, b) => {
    const x = a[field],
      y = b[field];
    const compared =
      x == null
        ? y == null
          ? 0
          : -1
        : y == null
          ? 1
          : typeof x === 'number' && typeof y === 'number'
            ? x - y
            : cellText(
                info.fields[field],
                x,
                description.models,
                lookup,
              ).localeCompare(
                cellText(info.fields[field], y, description.models, lookup),
              );
    return descending ? -compared : compared;
  });
});
function sort(name: string) {
  if (sortField === name) descending = !descending;
  else {
    sortField = name;
    descending = false;
  }
}
const lookup = $derived(indexReferences(references));
const methods = $derived(Object.entries(info.methods));
const base = $derived(modelHref(model));

let target: RecordRow | null = $state(null);
let deleting = $state(false);
let deleteError = $state('');
let pending: PendingApproval | null = $state(null);

async function confirmDelete() {
  if (!target) return;
  deleting = true;
  deleteError = '';
  try {
    const { data } = await api.remove(model, target.id, description.mode);
    target = null;
    if (isPendingApproval(data)) {
      pending = data;
      await invalidate(DEPENDS.shell);
    } else {
      await invalidate(DEPENDS.records);
    }
  } catch (e) {
    deleteError = e instanceof ApiError ? e.message : 'Could not delete.';
  } finally {
    deleting = false;
  }
}
</script>

{#if pending}
  <p class="sh-alert sh-alert-warn" role="status">
    Waiting for your approval: {pending.summary}. Nothing is deleted yet.
    <a class="sh-link" href="/approvals">Review it on the Approvals page</a>.
  </p>
{/if}

{#if sorted.length === 0}
  <div class="sh-empty">
    <p><strong>No {info.label.toLowerCase()} yet</strong></p>
    <p class="sh-muted">Add the first one to get started.</p>
    <a class="sh-btn sh-btn-primary" href="{base}/new">New {info.label.toLowerCase()}</a>
  </div>
{:else}
  <div class="sh-tablewrap">
    <table class="sh-table">
      <caption class="sr-only">{info.label}, newest first</caption>
      <thead>
        <tr>
          {#each columns as col (col.name)}<th scope="col" aria-sort={sortField === col.name ? descending ? 'descending' : 'ascending' : 'none'}><button class="sh-btn sh-btn-small" onclick={() => sort(col.name)}>{col.label}</button></th>{/each}
          <th scope="col" class="sr-only">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each sorted as row (row.id)}
          <tr>
            {#each columns as col, c (col.name)}
              <td>
                {#if c === 0}
                  <a class="sh-link" href="{base}/{encodeURIComponent(row.id)}">
                    {cellText(col.def, row[col.name], description.models, lookup) ||
                      recordLabel(info, row)}
                  </a>
                {:else}
                  {cellText(col.def, row[col.name], description.models, lookup)}
                {/if}
              </td>
            {/each}
            {#if columns.length === 0}
              <td><a class="sh-link" href="{base}/{encodeURIComponent(row.id)}">{recordLabel(info, row)}</a></td>
            {/if}
            <td class="sh-row-actions">
              <a class="sh-btn sh-btn-small" href="{base}/{encodeURIComponent(row.id)}">
                Edit<span class="sr-only"> {recordLabel(info, row)}</span>
              </a>
              <button
                type="button"
                class="sh-btn sh-btn-small sh-btn-danger"
                onclick={() => {
                  deleteError = '';
                  target = row;
                }}
              >
                Delete<span class="sr-only"> {recordLabel(info, row)}</span>
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if methods.length}
  <section class="methods" aria-label="Actions for {info.label}">
    <h2>Actions</h2>
    {#each methods as [name, method] (name)}
      <MethodRunner target={description.mode} className={info.className} {name} {method} />
    {/each}
  </section>
{/if}

<ConfirmDialog
  open={target !== null}
  title="Delete this {info.label.toLowerCase()}?"
  confirmLabel={description.mode === 'draft' ? 'Delete' : 'Ask to delete'}
  danger
  busy={deleting}
  error={deleteError}
  onconfirm={confirmDelete}
  oncancel={() => (target = null)}
>
  <p>
    {#if description.mode === 'draft'}
      Delete <strong>{target ? recordLabel(info, target) : ''}</strong> from the draft? Your live record stays unchanged.
    {:else}
      <strong>{target ? recordLabel(info, target) : ''}</strong> will not be
      deleted right away. The request goes to your Approvals page and the record
      stays until you approve it.
    {/if}
  </p>
</ConfirmDialog>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .methods {
    margin-block-start: var(--smrt-spacing-xl, 1.5rem);
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
