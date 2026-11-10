<script lang="ts">
import { goto, invalidate } from '$app/navigation';
import { ApiError, isPendingApproval, records } from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import {
  changedFields,
  type FormValues,
  fieldOfError,
  formFields,
  initialValues,
  recordLabel,
  serializeForm,
  stripFieldPrefix,
} from '$lib/ui/fields';
import { modelHref } from '$lib/ui/menu';
import type { Description, PendingApproval, RecordRow } from '$lib/ui/types';
import ConfirmDialog from './ConfirmDialog.svelte';
import FieldInput from './FieldInput.svelte';
import MethodRunner from './MethodRunner.svelte';

interface Props {
  /** The model's name in the definition. */
  model: string;
  description: Description;
  /** The record being edited; omit for a new one. */
  record?: RecordRow | null;
  /** Records of the models this one refers to, by model name. */
  references?: Record<string, RecordRow[]>;
}

let { model, description, record = null, references = {} }: Props = $props();

const info = $derived(description.models[model]);
const specs = $derived(formFields(info));
const uid = `f-${Math.random().toString(36).slice(2, 8)}`;
const editing = $derived(record !== null);

let values: FormValues = $state({});
let errors: Record<string, string> = $state({});
let formError = $state('');
let saving = $state(false);
let saved = $state(false);
let pending: PendingApproval | null = $state(null);
let confirming = $state(false);
let deleteError = $state('');
let deleting = $state(false);

// Load the record into the form. A fresh server copy of the same record (a
// live update) never overwrites what the owner is typing.
let touched = false;
let loadedId: string | null | undefined;
$effect(() => {
  const id = record?.id ?? null;
  if (id !== loadedId || !touched) {
    values = initialValues(info.fields, record);
    errors = {};
    touched = false;
  }
  loadedId = id;
});

async function save(event: SubmitEvent) {
  event.preventDefault();
  formError = '';
  saved = false;
  const only = record ? changedFields(info.fields, values, record) : undefined;
  if (record && only?.length === 0) {
    saved = true;
    return;
  }
  const { data, errors: found } = serializeForm(info.fields, values, only);
  errors = found;
  if (Object.keys(found).length) {
    formError = 'Fix the highlighted fields.';
    return;
  }
  saving = true;
  try {
    if (record) {
      await records.update(model, record.id, data);
      touched = false;
      await invalidate(DEPENDS.records);
      saved = true;
    } else {
      await records.create(model, data);
      touched = false;
      await invalidate(DEPENDS.records);
      await goto(modelHref(model));
    }
  } catch (e) {
    const message = e instanceof ApiError ? e.message : 'Could not save.';
    const field = fieldOfError(message, model, Object.keys(info.fields));
    if (field) {
      errors = { ...errors, [field]: stripFieldPrefix(message, model) };
      formError = 'Fix the highlighted fields.';
    } else {
      formError = message;
    }
  } finally {
    saving = false;
  }
}

async function confirmDelete() {
  if (!record) return;
  deleting = true;
  deleteError = '';
  try {
    const { data } = await records.remove(model, record.id);
    confirming = false;
    if (isPendingApproval(data)) {
      pending = data;
      await invalidate(DEPENDS.shell);
    } else {
      await invalidate(DEPENDS.records);
      await goto(modelHref(model));
    }
  } catch (e) {
    deleteError = e instanceof ApiError ? e.message : 'Could not delete.';
  } finally {
    deleting = false;
  }
}

const methods = $derived(Object.entries(info.methods));
</script>

<form
  oninput={() => (touched = true)}
  onchange={() => (touched = true)}
  onsubmit={save}
  novalidate aria-describedby={formError ? `${uid}-err` : undefined}>
  {#if formError}
    <p class="sh-alert sh-alert-error" role="alert" id="{uid}-err">{formError}</p>
  {/if}
  {#each specs as spec (spec.name)}
    <FieldInput
      id="{uid}-{spec.name}"
      {spec}
      bind:value={values[spec.name]}
      error={errors[spec.name]}
      options={spec.ref ? (references[spec.ref] ?? []) : []}
      refModel={spec.ref ? description.models[spec.ref] : undefined}
      disabled={saving}
    />
  {/each}
  {#if specs.length === 0}
    <p class="sh-muted">This model has no fields yet. Ask the assistant to add some.</p>
  {/if}

  <div class="sh-actions">
    <button type="submit" class="sh-btn sh-btn-primary" disabled={saving || specs.length === 0}>
      {saving ? 'Saving…' : editing ? 'Save changes' : 'Create'}
    </button>
    <a class="sh-btn" href={modelHref(model)}>{editing ? 'Back to list' : 'Cancel'}</a>
    {#if editing}
      <button
        type="button"
        class="sh-btn sh-btn-danger"
        onclick={() => {
          deleteError = '';
          confirming = true;
        }}
      >
        Delete
      </button>
    {/if}
  </div>
  <p class="sh-muted" aria-live="polite" role="status">{saved ? 'Saved.' : ''}</p>
</form>

{#if pending}
  <p class="sh-alert sh-alert-warn" role="status">
    Waiting for your approval: {pending.summary}. Nothing is deleted yet.
    <a class="sh-link" href="/approvals">Review it on the Approvals page</a>.
  </p>
{/if}

{#if editing && record && methods.length}
  <section aria-labelledby="{uid}-methods">
    <h2 id="{uid}-methods">Actions</h2>
    {#each methods as [name, method] (name)}
      <MethodRunner
        className={info.className}
        {name}
        {method}
        recordId={record.id}
      />
    {/each}
  </section>
{/if}

{#if record}
  <ConfirmDialog
    open={confirming}
    title="Delete this {info.label.toLowerCase()}?"
    confirmLabel="Ask to delete"
    danger
    busy={deleting}
    error={deleteError}
    onconfirm={confirmDelete}
    oncancel={() => (confirming = false)}
  >
    <p>
      <strong>{recordLabel(info, record)}</strong> will not be deleted right
      away. The request goes to your Approvals page and the record stays until
      you approve it.
    </p>
  </ConfirmDialog>
{/if}
