<script lang="ts">
import { FieldLabel } from '@happyvertical/smrt-ui/forms';
import { tick } from 'svelte';
import { getModelByQualifiedName } from '../catalog/index.ts';
import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import {
  blankChild,
  cellValue,
  errorSummary,
  listColumns,
  missingRequired,
  recordTitle,
  rowsOf,
} from '../data/columns.ts';
import { useDataSource } from '../data/context.ts';
import {
  derivedFieldNames,
  isLineModel,
  isProductField,
  lineAmount,
  productPrefill,
} from '../data/derived.ts';
import type { ModelRecord } from '../data/fakes.ts';
import { formatValue } from '../data/format.ts';
import { relationLabels, shortId } from '../data/labels.ts';
import {
  type ListSort,
  nextListSort,
  sortListRows,
} from '../data/list-sort.ts';
import { focusFirstInvalid } from '../fields/invalid.ts';
import type { ViewField } from '../recipes/policy.ts';
import '../styles/planner-lists.css';
import FieldInput from './FieldInput.svelte';

interface ChildRecordsProps {
  model: CatalogModel;
  fields: ViewField[];
  /** The child's field that holds the parent's id; preset and never shown. */
  fk: string;
  parentId: string;
  title: string;
  /** Called after a row is added, changed or removed (the parent's totals moved). */
  onchanged?: () => void;
}

let {
  model,
  fields: allFields,
  fk,
  parentId,
  title,
  onchanged,
}: ChildRecordsProps = $props();

const source = useDataSource();
// The product comes first on a line item: picking it fills in the rest.
const fields = $derived(
  [...allFields.filter((f) => f.name !== fk)].sort(
    (a, b) =>
      Number(isLine && isProductField(b)) - Number(isLine && isProductField(a)),
  ),
);
const isLine = $derived(isLineModel(model));
const columns = $derived(listColumns(fields));
const calculated = $derived(derivedFieldNames(model, false));
/** The line's amount as it will be saved, live as quantity and price change. */
const derivedPreview = (name: string): unknown =>
  name === 'amount' ? lineAmount(draft) : draft[name];
let errors = $state<Record<string, string>>({});
let saveError = $state('');
let removeError = $state('');
const summary = $derived(errorSummary(fields, errors) || saveError);

let rows = $state<ModelRecord[]>([]);
let labels = $state(new Map<string, string>());
let sort = $state<ListSort | null>(null);
const sortedRows = $derived(
  sortListRows(rows, sort, (row, key) => {
    const column = columns.find((item) => item.name === key);
    if (!column) return undefined;
    const value = cellValue(column, row);
    return column.type === 'foreignKey' || column.type === 'crossPackageRef'
      ? formatValue(column, value, labels)
      : value;
  }),
);
let loaded = $state(false);
/** `null` closed, `'new'` adding, otherwise the id being edited. */
let editing = $state<string | 'new' | null>(null);
let draft = $state<Record<string, unknown>>({});
let formKey = $state(0);

async function load() {
  const listed = rowsOf(await source.list(model), fk, parentId);
  labels = await relationLabels(source, fields, listed);
  rows = listed;
  loaded = true;
}

$effect(() => {
  // Reload when the parent record (or the child model) changes.
  model.id;
  parentId;
  sort = null;
  editing = null;
  loaded = false;
  void load();
});

const nameOf = (row: ModelRecord) =>
  recordTitle(model, fields, row, labels) || shortId(row.id);

function startCreate() {
  errors = {};
  saveError = '';
  draft = blankChild(fields, fk, parentId);
  editing = 'new';
  formKey++;
}

function startEdit(row: ModelRecord) {
  errors = {};
  saveError = '';
  draft = { ...row };
  editing = row.id;
  formKey++;
}

/** A field changed; picking a product on a line fills description and price. */
async function changed(field: CatalogField, value: unknown) {
  draft[field.name] = value;
  delete errors[field.name];
  if (!isLine || !isProductField(field) || typeof value !== 'string') return;
  const target = field.related && getModelByQualifiedName(field.related)?.model;
  const product = target ? await source.get(target, value) : undefined;
  Object.assign(draft, productPrefill(model, product));
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
  values[fk] = parentId;
  try {
    if (editing === 'new') await source.create(model, values);
    else if (editing) await source.update(model, editing, values);
  } catch (failure) {
    // Money the model refuses (a discount above the line's price): the
    // write was undone, and the form stays open with the reason.
    saveError = failure instanceof Error ? failure.message : String(failure);
    return;
  }
  saveError = '';
  editing = null;
  await load();
  onchanged?.();
}

async function remove(row: ModelRecord) {
  removeError = '';
  try {
    await source.delete(model, row.id);
  } catch (failure) {
    // An issued document keeps its lines: the delete was undone.
    removeError = failure instanceof Error ? failure.message : String(failure);
    return;
  }
  await load();
  onchanged?.();
}
</script>

<section class="children" data-child-model={model.name}>
  <header>
    <h3>{title} <small>{rows.length}</small></h3>
    {#if removeError}
      <p class="error" role="alert" data-remove-error>{removeError}</p>
    {/if}
    <button type="button" class="secondary" onclick={startCreate}>
      Add {title.toLowerCase().replace(/s$/, '')}
    </button>
  </header>

  {#if editing}
    {#key formKey}
      <form onsubmit={save} novalidate>
        {#each fields as field (field.name)}
          {#if calculated.has(field.name)}
            <div class="derived">
              <FieldLabel label={field.label} />
              <output data-derived={field.name}>
                {formatValue(field, derivedPreview(field.name), labels)}
              </output>
              <small>Calculated from quantity, price, discount and tax.</small>
            </div>
          {:else}
            <FieldInput
              {field}
            error={errors[field.name]}
              modelId={model.id}
              label={field.label}
              help={field.help}
              value={draft[field.name]}
              onchange={(value) => changed(field, value)}
            />
          {/if}
        {/each}
        {#if summary}
          <p class="error" role="alert" data-error-summary>{summary}</p>
        {/if}
        <div class="actions">
          <button type="submit">Save</button>
          <button type="button" class="secondary" onclick={() => (editing = null)}>
            Cancel
          </button>
        </div>
      </form>
    {/key}
  {/if}

  {#if !loaded}
    <p>Loading...</p>
  {:else if rows.length === 0}
    <p class="empty">None yet.</p>
  {:else}
    <div class="scroll">
      <table class="planner-list">
        <thead>
          <tr>
            {#each columns as column (column.name)}
              <th scope="col" aria-sort={sort?.key === column.name ? sort.direction : 'none'}>
                <button type="button" class="sort-button" onclick={() => (sort = nextListSort(sort, column.name))}>
                  {column.label}<span class="sort-icon" aria-hidden="true">{sort?.key === column.name ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}</span>
                </button>
              </th>
            {/each}
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each sortedRows as row (row.id)}
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .children {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3) var(--smrt-spacing-4);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large);
  }

  header {
    display: flex;
    gap: var(--smrt-spacing-3);
    align-items: center;
    justify-content: space-between;
  }

  h3 {
    margin: 0;
    font: var(--smrt-typography-title-medium-font); letter-spacing: var(--smrt-typography-title-medium-tracking);
  }

  small,
  .empty {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 400;
  }

  p {
    margin: 0;
  }

  form {
    display: grid;
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
    font-size: 0.875rem;
  }

  th,
  td {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    border-bottom: var(--smrt-hairline);
    text-align: left;
    white-space: nowrap;
  }

  button {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    border: 0;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
    cursor: pointer;
  }

  button.secondary {
    border: var(--smrt-control-border);
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
}
</style>
