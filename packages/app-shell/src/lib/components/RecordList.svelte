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
const sorted = $derived(orderByCreated(rows));
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
    const { data } = await api.remove(model, target.id);
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
          {#each columns as col (col.name)}<th scope="col">{col.label}</th>{/each}
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
      <MethodRunner className={info.className} {name} {method} />
    {/each}
  </section>
{/if}

<ConfirmDialog
  open={target !== null}
  title="Delete this {info.label.toLowerCase()}?"
  confirmLabel="Ask to delete"
  danger
  busy={deleting}
  error={deleteError}
  onconfirm={confirmDelete}
  oncancel={() => (target = null)}
>
  <p>
    <strong>{target ? recordLabel(info, target) : ''}</strong> will not be
    deleted right away. The request goes to your Approvals page and the record
    stays until you approve it.
  </p>
</ConfirmDialog>

<style>
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
</style>
