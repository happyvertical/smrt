<script lang="ts">
import { goto, invalidate } from '$app/navigation';
import { can } from '$lib/ui/access';
import { ApiError, isPendingApproval, records } from '$lib/ui/api';
import { cellText, indexReferences } from '$lib/ui/columns';
import { DEPENDS } from '$lib/ui/events';
import {
  changedFields,
  type FormValues,
  fieldOfError,
  formFields,
  initialValues,
  recordLabel,
  serializeForm,
  singularLabel,
  stripFieldPrefix,
} from '$lib/ui/fields';
import { formulaWords } from '$lib/ui/formula';
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
  /** Values a new record starts with (link fields set from a related tab). */
  prefill?: Record<string, string>;
  /** Where to go after a new record is saved; default its table. */
  returnTo?: string | null;
}

let {
  model,
  description,
  record = null,
  references = {},
  prefill = {},
  returnTo = null,
}: Props = $props();

const info = $derived(description.models[model]);
const specs = $derived(formFields(info));
const uid = `f-${Math.random().toString(36).slice(2, 8)}`;
const editing = $derived(record !== null);
const canUpdate = $derived(can(description, model, 'update'));
const canDelete = $derived(can(description, model, 'delete'));
const lookup = $derived(indexReferences(references));
const singular = $derived(singularLabel(info.label).toLowerCase());
// A saved record opens as a read view; Edit swaps in the form.
let changing = $state(false);
const reading = $derived(editing && !changing);
const shown = (def: (typeof info.fields)[string], value: unknown) =>
  cellText(def, value, description.models, lookup) || '—';

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
    values = {
      ...initialValues(info.fields, record),
      ...(record ? {} : prefill),
    };
    errors = {};
    touched = false;
  }
  if (id !== loadedId) changing = false;
  loadedId = id;
});

async function save(event: SubmitEvent) {
  event.preventDefault();
  formError = '';
  saved = false;
  const only = record ? changedFields(info.fields, values, record) : undefined;
  if (record && only?.length === 0) {
    saved = true;
    changing = false;
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
      await records.update(model, record.id, data, description.mode);
      touched = false;
      await invalidate(DEPENDS.records);
      saved = true;
      changing = false;
    } else {
      await records.create(model, data, description.mode);
      touched = false;
      await invalidate(DEPENDS.records);
      await goto(returnTo ?? modelHref(model));
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
    const { data } = await records.remove(model, record.id, description.mode);
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

function cancelEdit() {
  touched = false;
  errors = {};
  formError = '';
  values = initialValues(info.fields, record);
  changing = false;
}
function askDelete() {
  deleteError = '';
  confirming = true;
}
</script>

{#snippet deleteButton()}
  {#if canDelete}
    <button type="button" class="smrt-app-shell__btn smrt-app-shell__btn-danger" onclick={askDelete}>Delete</button>
  {/if}
{/snippet}

{#if reading && record}
  <section class="smrt-record-form__details" aria-label="{info.label} details" data-smrt-part="details">
    <dl class="smrt-record-form__grid">
      {#each specs as spec (spec.name)}
        {@const field = info.fields[spec.name]}
        <div class="smrt-record-form__item">
          <dt class="smrt-app-shell__muted">{spec.label}</dt>
          <dd>{shown(field, record[spec.name])}</dd>
        </div>
      {/each}
    </dl>
    {#if specs.length === 0}
      <p class="smrt-app-shell__muted">This model has no fields yet. Ask the assistant to add some.</p>
    {/if}
    <div class="smrt-app-shell__actions">
      {#if canUpdate}
        <button type="button" class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={specs.length === 0} onclick={() => {
            saved = false;
            changing = true;
          }}>
          Edit
        </button>
      {/if}
      <a class="smrt-app-shell__btn" href={modelHref(model)}>Back to list</a>
      {@render deleteButton()}
    </div>
    <p class="smrt-app-shell__muted" aria-live="polite" role="status">{saved ? 'Saved.' : ''}</p>
  </section>
{:else}
<form
  oninput={() => (touched = true)}
  onchange={() => (touched = true)}
  onsubmit={save}
  novalidate aria-describedby={formError ? `${uid}-err` : undefined}>
  {#if formError}
    <p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert" id="{uid}-err">{formError}</p>
  {/if}
  {#each specs as spec (spec.name)}
    {@const field = info.fields[spec.name]}
    {#if field.calculated}
      <div class="smrt-app-shell__field"><p class="smrt-app-shell__label">{spec.label} <small class="smrt-app-shell__muted">calculated</small></p>
        <output aria-label={spec.label}>{record ? cellText(field, record[spec.name]) : ''}</output>
        <p class="smrt-app-shell__muted">{formulaWords(field.calculated, info.fields)}{#if !record} · Available after saving.{/if}</p>
      </div>
    {:else}
    <FieldInput
      id="{uid}-{spec.name}"
      {spec}
      bind:value={values[spec.name]}
      error={errors[spec.name]}
      options={spec.ref ? (references[spec.ref] ?? []) : []}
      refModel={spec.ref ? description.models[spec.ref] : undefined}
      disabled={saving}
    />
    {/if}
  {/each}
  {#if specs.length === 0}
    <p class="smrt-app-shell__muted">This model has no fields yet. Ask the assistant to add some.</p>
  {/if}

  <div class="smrt-app-shell__actions">
    <button type="submit" class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={saving || specs.length === 0}>
      {saving ? 'Saving…' : editing ? 'Save changes' : 'Create'}
    </button>
    {#if editing}
      <button type="button" class="smrt-app-shell__btn" disabled={saving} onclick={cancelEdit}>Cancel</button>
      {@render deleteButton()}
    {:else}
      <a class="smrt-app-shell__btn" href={modelHref(model)}>Cancel</a>
    {/if}
  </div>
  <p class="smrt-app-shell__muted" aria-live="polite" role="status">{saved ? 'Saved.' : ''}</p>
</form>
{/if}

{#if pending}
  <p class="smrt-app-shell__alert smrt-app-shell__alert-warn" role="status">
    Waiting for your approval: {pending.summary}. Nothing is deleted yet.
    <a class="smrt-app-shell__link" href="/approvals">Review it on the Approvals page</a>.
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
        target={description.mode}
      />
    {/each}
  </section>
{/if}

{#if record}
  <ConfirmDialog
    open={confirming}
    title="Delete this {singular}?"
    confirmLabel={description.mode === 'draft' ? 'Delete' : 'Ask to delete'}
    danger
    busy={deleting}
    error={deleteError}
    onconfirm={confirmDelete}
    oncancel={() => (confirming = false)}
  >
    <p>
      {#if description.mode === 'draft'}
        Delete <strong>{recordLabel(info, record)}</strong> from the draft? Your live record stays unchanged.
      {:else}
        <strong>{recordLabel(info, record)}</strong> will not be deleted right
        away. The request goes to your Approvals page and the record stays until
        you approve it.
      {/if}
    </p>
  </ConfirmDialog>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-record-form__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
    gap: var(--smrt-spacing-md, 0.75rem) var(--smrt-spacing-lg, 1rem);
    margin: 0 0 var(--smrt-spacing-lg, 1rem);
  }
  .smrt-record-form__item dd {
    margin: 0;
    overflow-wrap: break-word;
  }
}

@layer smrt.theme {
  .smrt-record-form__item dt {
    font-size: 0.8125rem;
  }
}
</style>
