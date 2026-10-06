<script lang="ts">
import type { CatalogModel } from '../catalog/types.ts';
import { useDataSource } from '../data/context.ts';
import { editableFields, type ModelRecord } from '../data/fakes.ts';
import { formatValue, humanize } from '../data/format.ts';
import { relationLabels } from '../data/labels.ts';
import { isRelation } from '../fields/renderer.ts';
import { type ActiveForm, isFieldMap } from '../forms/active.ts';
import type { ViewField } from '../recipes/policy.ts';
import type { FieldMapForm as FieldMapFormShape } from '../recipes/types.ts';
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
}

let { model, fields: shownFields, forms = [] }: ModelWorkspaceProps = $props();

const source = useDataSource();
const fields = $derived<ViewField[]>(
  shownFields ??
    editableFields(model).map((f) => ({ ...f, label: humanize(f.name) })),
);
const mapForms = $derived(
  forms.filter((f): f is ActiveForm<FieldMapFormShape> => isFieldMap(f)),
);
const columns = $derived.by((): ViewField[] => {
  const shown = fields.filter((f) => f.type !== 'json');
  // A few leading fields, then the numeric/boolean/date ones (prices,
  // quantities, flags) and the choices (enums, relations) so a row reads like
  // a record, not a wall of text.
  const lead = shown.slice(0, 3);
  const rest = shown
    .slice(3)
    .filter(
      (f) =>
        ['integer', 'decimal', 'boolean', 'datetime'].includes(f.type) ||
        (f.enum?.length ?? 0) > 0 ||
        isRelation(f),
    );
  return [...lead, ...rest].slice(0, 6);
});

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

async function load() {
  const listed = await source.list(model);
  labels = await relationLabels(source, columns, listed);
  rows = listed;
  loaded = true;
}

$effect(() => {
  // Reload (and close any open form) when the model changes.
  model.id;
  editing = null;
  loaded = false;
  void load();
});

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
  const blank: Record<string, unknown> = {};
  for (const field of fields) {
    blank[field.name] =
      field.default ??
      (field.type === 'boolean' ? false : field.type === 'text' ? '' : null);
  }
  draft = blank;
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
  editing = row.id;
  formKey++;
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  const values: Record<string, unknown> = {};
  for (const field of fields) values[field.name] = draft[field.name];
  if (editing === 'new') await source.create(model, values);
  else if (editing) await source.update(model, editing, values);
  editing = null;
  await load();
}

async function remove(row: ModelRecord) {
  await source.delete(model, row.id);
  await load();
}
</script>

<section>
  <header>
    <h2>{model.name} <small>{rows.length} sample rows</small></h2>
    {#if mapForms.length}
      {#each mapForms as active (active.form.id)}
        <button type="button" onclick={() => startCreate(active)}>
          New {active.form.label.toLowerCase()}
        </button>
      {/each}
    {:else}
      <button type="button" onclick={() => startCreate()}>New {model.name}</button>
    {/if}
  </header>

  {#if editing}
    {#key formKey}
    {#if mapForm}
      <FieldMapForm
        active={mapForm}
        id={editing === 'new' ? undefined : editing}
        onsaved={savedMap}
        oncancel={() => (editing = null)}
      />
    {:else}
    <form onsubmit={save}>
      <h3>{editing === 'new' ? `New ${model.name}` : `Edit ${model.name}`}</h3>
      {#each fields as field (field.name)}
        <FieldInput
          {field}
          modelId={model.id}
          label={field.label}
          help={field.help}
          value={draft[field.name]}
          onchange={(value) => (draft[field.name] = value)}
        />
      {/each}
      <div class="actions">
        <button type="submit">Save</button>
        <button type="button" class="secondary" onclick={() => (editing = null)}>
          Cancel
        </button>
      </div>
    </form>
    {/if}
    {/key}
  {/if}

  {#if !loaded}
    <p>Loading sample data...</p>
  {:else if rows.length === 0}
    <p>No rows yet. Create one above.</p>
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
                <td>{formatValue(column, row[column.name], labels)}</td>
              {/each}
              <td class="row-actions">
                <button type="button" class="secondary" onclick={() => startEdit(row)}>
                  Edit
                </button>
                <button type="button" class="secondary" onclick={() => remove(row)}>
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
