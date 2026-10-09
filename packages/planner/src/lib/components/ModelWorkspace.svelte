<script lang="ts">
import { FieldLabel } from '@happyvertical/smrt-ui/forms';
import { tick } from 'svelte';
import { page } from '$app/state';
import type { CatalogModel } from '../catalog/types.ts';
import {
  blankRecord,
  type ChildTable,
  cellValue,
  errorSummary,
  listColumns,
  missingRequired,
  recordTitle,
} from '../data/columns.ts';
import { useDataSource } from '../data/context.ts';
import {
  derivedFieldNames,
  isAllocationModel,
  isLineModel,
  TOTAL_FIELDS,
} from '../data/derived.ts';
import { editableFields, type ModelRecord } from '../data/fakes.ts';
import {
  createNoun,
  fieldLabel,
  formatValue,
  humanize,
  pluralize,
  recordCount,
} from '../data/format.ts';
import { relationLabels, shortId } from '../data/labels.ts';
import { focusFirstInvalid } from '../fields/invalid.ts';
import { type ActiveForm, isFieldMap } from '../forms/active.ts';
import { takeCreate } from '../planner/create.ts';
import type { ViewField } from '../recipes/policy.ts';
import { inScope, type RowScope } from '../recipes/scope.ts';
import type { FieldMapForm as FieldMapFormShape } from '../recipes/types.ts';
import ChildRecords from './ChildRecords.svelte';
import FieldInput from './FieldInput.svelte';
import FieldMapForm from './FieldMapForm.svelte';

interface ModelWorkspaceProps {
  model: CatalogModel;
  /** The fields to show, policy applied; defaults to every editable field. */
  fields?: ViewField[];
  /**
   * The forms of the added recipes for this model. A field-map form replaces
   * the generic one: New offers each, and Edit uses the first, so the related
   * rows it saves (a Customer's Profile) are edited together.
   */
  forms?: ActiveForm[];
  /**
   * Records that live inside this one (line items): shown under an open
   * record, filtered to it, with the foreign key preset and hidden.
   */
  childTables?: ChildTable[];
  /** The list's heading (the menu entry's label); defaults to the plural name. */
  title?: string;
  /** What New creates, e.g. "sales order"; defaults to the model's name. */
  noun?: string;
  /** The slice of rows this page lists (a filtered nav entry), if any. */
  scope?: RowScope;
  /** Values a new row carries so it stays in `scope`. */
  preset?: Record<string, unknown>;
}

let {
  model,
  fields: shownFields,
  forms = [],
  childTables = [],
  title,
  noun,
  scope,
  preset,
}: ModelWorkspaceProps = $props();

const source = useDataSource();
const fields = $derived<ViewField[]>(
  shownFields ??
    editableFields(model).map((f) => ({ ...f, label: fieldLabel(f) })),
);
const mapForms = $derived(
  forms.filter((f): f is ActiveForm<FieldMapFormShape> => isFieldMap(f)),
);
const columns = $derived(listColumns(fields));
/** Shown but not typed: a line's amount, a parent's totals. */
const calculated = $derived(
  derivedFieldNames(
    model,
    childTables.some((c) => isLineModel(c.model)),
    childTables.some((c) => isAllocationModel(c.model)),
  ),
);
/** Subtotal, tax and total, shown as one summary. */
const totalFields = $derived(
  fields.filter(
    (f) =>
      calculated.has(f.name) &&
      (TOTAL_FIELDS as readonly string[]).includes(f.name),
  ),
);
const newNoun = $derived(noun ?? humanize(model.name).toLowerCase());
const heading = $derived(title ?? pluralize(humanize(model.name)));

let rows = $state<ModelRecord[]>([]);
/** Labels of the records the rows point at, so a cell shows a name, not an id. */
let labels = $state(new Map<string, string>());
let loaded = $state(false);
/** `null` closed, `'new'` creating, otherwise the id being edited. */
let editing = $state<string | 'new' | null>(null);
/** The field-map form open when `mapForms` replace the generic form. */
let mapForm = $state<ActiveForm<FieldMapFormShape> | undefined>(undefined);
let draft = $state<Record<string, unknown>>({});
/** Bumped each time a form opens, so inputs remount with the new draft. */
let formKey = $state(0);
/** Required fields the last save found empty, by field name. */
let errors = $state<Record<string, string>>({});
const summary = $derived(errorSummary(fields, errors));
/** What names a row to a person: its customer or reference, else a short id. */
const nameOf = (row: ModelRecord) =>
  recordTitle(model, fields, row, labels) || shortId(row.id);
const editTitle = $derived(
  editing && editing !== 'new'
    ? recordTitle(
        model,
        fields,
        rows.find((r) => r.id === editing) ?? {},
        labels,
      )
    : '',
);

async function load() {
  const listed = (await source.list(model)).filter((row) =>
    inScope(scope, row),
  );
  labels = await relationLabels(source, fields, listed);
  rows = listed;
  loaded = true;
}

$effect(() => {
  // Reload (and close any open form) when the model changes.
  model.id;
  scope;
  editing = null;
  loaded = false;
  void load().then(() => {
    // A section page's "New ..." arrives with the form already open.
    if (takeCreate(page.url.pathname)) startCreate(mapForms[0]);
  });
});

// A reset (a cookbook applied, the app reset) swaps the rows underneath an
// open page: read them again rather than keep showing the old ones.
$effect(() => source.onReset?.(() => void load()));

async function savedMap() {
  editing = null;
  await load();
}

function startCreate(form?: ActiveForm<FieldMapFormShape>) {
  if (form) {
    mapForm = form;
    editing = 'new';
    formKey++;
    return;
  }
  mapForm = undefined;
  draft = { ...blankRecord(fields), ...preset };
  errors = {};
  editing = 'new';
  formKey++;
}

function startEdit(row: ModelRecord) {
  if (mapForms[0]) {
    mapForm = mapForms[0];
    editing = row.id;
    formKey++;
    return;
  }
  mapForm = undefined;
  draft = { ...row };
  errors = {};
  editing = row.id;
  formKey++;
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget;
  errors = missingRequired(fields, draft, calculated);
  if (Object.keys(errors).length > 0) {
    await tick();
    focusFirstInvalid(form);
    return;
  }
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (!calculated.has(field.name)) values[field.name] = draft[field.name];
  }
  if (editing === 'new') {
    const created = await source.create(model, values);
    // A record with line items stays open after its first save, so they can
    // be added to it right away.
    editing = childTables.length ? created.id : null;
    if (editing) {
      draft = { ...created };
      formKey++;
    }
  } else if (editing) {
    await source.update(model, editing, values);
    editing = null;
  }
  await load();
}

/** A line item changed: bring the open record's calculated totals up to date. */
async function refreshDerived() {
  if (!editing || editing === 'new') return;
  const fresh = await source.get(model, editing);
  if (fresh) {
    for (const name of calculated) draft[name] = fresh[name];
    // What is paid moves the status too (paid, overdue).
    if (calculated.has('amountPaid')) draft.status = fresh.status;
  }
  await load();
}

async function remove(row: ModelRecord) {
  await source.delete(model, row.id);
  await load();
}
</script>

<section>
  <header>
    <h2>{heading} {#if loaded}<small>{recordCount(rows.length)}</small>{/if}</h2>
    {#if mapForms.length}
      {#each mapForms as active (active.form.id)}
        <button type="button" onclick={() => startCreate(active)}>
          New {createNoun(active.form.label, noun, mapForms.length === 1)}
        </button>
      {/each}
    {:else}
      <button type="button" onclick={() => startCreate()}>New {newNoun}</button>
    {/if}
  </header>

  {#if editing}
    {#key formKey}
    {#if mapForm}
      <FieldMapForm
        active={mapForm}
        id={editing === 'new' ? undefined : editing}
        {preset}
        noun={mapForms.length === 1 ? noun : undefined}
        onsaved={savedMap}
        oncancel={() => (editing = null)}
      />
    {:else}
    <form onsubmit={save} novalidate>
      <h3>{editing === 'new' ? `New ${newNoun}` : editTitle || model.name}</h3>
      {#each fields as field (field.name)}
        {#if totalFields.includes(field)}
          {#if field === totalFields[0]}
            <div class="derived totals" data-derived-group="totals">
              <dl>
                {#each totalFields as total (total.name)}
                  <div>
                    <dt>{total.label}</dt>
                    <dd>
                      <output data-derived={total.name}>
                        {formatValue(total, draft[total.name] ?? 0, labels)}
                      </output>
                    </dd>
                  </div>
                {/each}
              </dl>
              <small>Calculated from the line items.</small>
            </div>
          {/if}
        {:else if calculated.has(field.name)}
          <div class="derived">
            <FieldLabel label={field.label} />
            <output data-derived={field.name}>
              {formatValue(field, draft[field.name] ?? 0, labels) || '—'}
            </output>
            <small>Calculated from the payments applied to this record.</small>
          </div>
        {:else}
          <FieldInput
            {field}
        error={errors[field.name]}
            modelId={model.id}
            label={field.label}
            help={field.help}
            value={draft[field.name]}
            onchange={(value) => {
              draft[field.name] = value;
              delete errors[field.name];
            }}
          />
        {/if}
      {/each}
      {#if summary}
        <p class="error" role="alert" data-error-summary>{summary}</p>
      {/if}
      <div class="actions">
        <button type="submit">Save</button>
        <button type="button" class="secondary" onclick={() => (editing = null)}>
          {childTables.length ? 'Back to list' : 'Cancel'}
        </button>
      </div>
    </form>
    {/if}
    {/key}
    {#if editing !== 'new'}
      {#each childTables as child (child.model.id)}
        <ChildRecords
          model={child.model}
          fields={child.fields}
          fk={child.fk}
          title={child.title}
          parentId={editing}
          onchanged={refreshDerived}
        />
      {/each}
    {/if}
  {/if}

  {#if editing && childTables.length}
    <!-- The open record (with its line items) stands in for the list. -->
  {:else if !loaded}
    <p>Loading...</p>
  {:else if rows.length === 0}
    <p>No records yet. Create one above.</p>
  {:else}
    <div class="scroll">
      <table>
        <thead>
          <tr>
            {#each columns as column (column.name)}
              <th>{column.label}</th>
            {/each}
            <th><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              {#each columns as column (column.name)}
                <td>{formatValue(column, cellValue(column, row), labels)}</td>
              {/each}
              <td class="row-actions">
                <button
                  type="button"
                  class="secondary"
                  aria-label={`Edit ${nameOf(row)}`}
                  onclick={() => startEdit(row)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="secondary"
                  aria-label={`Delete ${nameOf(row)}`}
                  onclick={() => remove(row)}
                >
                  Delete
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  header {
    display: flex;
    gap: var(--smrt-spacing-3);
    align-items: center;
    justify-content: space-between;
  }

  h2,
  h3 {
    margin: 0;
  }

  small {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 400;
  }

  form {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  .actions,
  .row-actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  .error {
    margin: 0;
    color: var(--smrt-color-error);
  }

  .derived {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .totals dl {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2) var(--smrt-spacing-6);
    margin: 0 0 var(--smrt-spacing-1);
  }

  .totals dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
  }

  .totals dd {
    margin: 0;
    font-weight: 600;
  }

  .scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    text-align: left;
    white-space: nowrap;
  }

  button {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 0;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
    cursor: pointer;
  }

  button.secondary {
    border: 1px solid var(--smrt-color-outline);
    background: transparent;
    color: var(--smrt-color-on-surface);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
