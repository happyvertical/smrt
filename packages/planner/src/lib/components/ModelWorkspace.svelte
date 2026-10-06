<script lang="ts">
import type { CatalogField, CatalogModel } from '../catalog/types.ts';
import { useDataSource } from '../data/context.ts';
import { editableFields, type ModelRecord } from '../data/fakes.ts';
import { formatValue, humanize } from '../data/format.ts';
import FieldInput from './FieldInput.svelte';

interface ModelWorkspaceProps {
  model: CatalogModel;
}

let { model }: ModelWorkspaceProps = $props();

const source = useDataSource();
const fields = $derived(editableFields(model));
const columns = $derived.by((): CatalogField[] => {
  const shown = fields.filter((f) => f.type !== 'json');
  // A few leading text fields, then the numeric/boolean/date ones (prices,
  // quantities, flags) so a row reads like a record, not a wall of text.
  const lead = shown.slice(0, 3);
  const rest = shown
    .slice(3)
    .filter((f) =>
      ['integer', 'decimal', 'boolean', 'datetime'].includes(f.type),
    );
  return [...lead, ...rest].slice(0, 6);
});

let rows = $state<ModelRecord[]>([]);
let loaded = $state(false);
/** `null` closed, `'new'` creating, otherwise the id being edited. */
let editing = $state<string | 'new' | null>(null);
let draft = $state<Record<string, unknown>>({});

async function load() {
  rows = await source.list(model);
  loaded = true;
}

$effect(() => {
  // Reload (and close any open form) when the model changes.
  model.id;
  editing = null;
  loaded = false;
  void load();
});

function startCreate() {
  const blank: Record<string, unknown> = {};
  for (const field of fields) {
    blank[field.name] =
      field.default ??
      (field.type === 'boolean' ? false : field.type === 'text' ? '' : null);
  }
  draft = blank;
  editing = 'new';
}

function startEdit(row: ModelRecord) {
  draft = { ...row };
  editing = row.id;
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
    <button type="button" onclick={startCreate}>New {model.name}</button>
  </header>

  {#if editing}
    <form onsubmit={save}>
      <h3>{editing === 'new' ? `New ${model.name}` : `Edit ${model.name}`}</h3>
      {#each fields as field (field.name)}
        <FieldInput
          {field}
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
              <th>{humanize(column.name)}</th>
            {/each}
            <th><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              {#each columns as column (column.name)}
                <td>{formatValue(column, row[column.name])}</td>
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
