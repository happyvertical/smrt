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
  <p class="smrt-app-shell__alert smrt-app-shell__alert-warn" role="status" data-smrt-part="status">
    Waiting for your approval: {pending.summary}. Nothing is deleted yet.
    <a class="smrt-app-shell__link" href="/approvals" data-smrt-part="link">Review it on the Approvals page</a>.
  </p>
{/if}

{#if sorted.length === 0}
  <div class="smrt-app-shell__empty" data-smrt-part="empty">
    <p><strong>No {info.label.toLowerCase()} yet</strong></p>
    <p class="smrt-app-shell__muted" data-smrt-part="description">Add the first one to get started.</p>
    <a class="smrt-app-shell__btn smrt-app-shell__btn-primary" href="{base}/new" data-smrt-part="trigger">New {info.label.toLowerCase()}</a>
  </div>
{:else}
  <div class="smrt-app-shell__tablewrap" data-smrt-part="body">
    <table class="smrt-app-shell__table" data-smrt-part="table">
      <caption class="smrt-record-list__sr-only" data-smrt-part="label">{info.label}, newest first</caption>
      <thead>
        <tr>
          {#each columns as col (col.name)}<th scope="col">{col.label}</th>{/each}
          <th scope="col" class="smrt-record-list__sr-only" data-smrt-part="label">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each sorted as row (row.id)}
          <tr>
            {#each columns as col, c (col.name)}
              <td>
                {#if c === 0}
                  <a class="smrt-app-shell__link" href="{base}/{encodeURIComponent(row.id)}" data-smrt-part="link">
                    {cellText(col.def, row[col.name], description.models, lookup) ||
                      recordLabel(info, row)}
                  </a>
                {:else}
                  {cellText(col.def, row[col.name], description.models, lookup)}
                {/if}
              </td>
            {/each}
            {#if columns.length === 0}
              <td><a class="smrt-app-shell__link" href="{base}/{encodeURIComponent(row.id)}" data-smrt-part="link">{recordLabel(info, row)}</a></td>
            {/if}
            <td class="smrt-app-shell__row-actions" data-smrt-part="actions">
              <a class="smrt-app-shell__btn smrt-app-shell__btn-small" href="{base}/{encodeURIComponent(row.id)}" data-smrt-part="trigger">
                Edit<span class="smrt-record-list__sr-only" data-smrt-part="label"> {recordLabel(info, row)}</span>
              </a>
              <button
                type="button"
                class="smrt-app-shell__btn smrt-app-shell__btn-small smrt-app-shell__btn-danger"
                onclick={() => {
                  deleteError = '';
                  target = row;
                }} data-smrt-part="trigger"
              >
                Delete<span class="smrt-record-list__sr-only" data-smrt-part="label"> {recordLabel(info, row)}</span>
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if methods.length}
  <section class="smrt-record-list__methods" aria-label="Actions for {info.label}" data-smrt-part="actions">
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

@layer smrt.structure {
  .smrt-record-list__methods {
    margin-block-start: var(--smrt-spacing-xl, 1.5rem);
  }
  .smrt-record-list__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

@layer smrt.theme {
}
</style>
