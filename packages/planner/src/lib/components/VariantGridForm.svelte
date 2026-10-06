<script lang="ts">
import { TagsInput } from '@happyvertical/smrt-ui/forms';
import { useDataSource } from '../data/context.ts';
import type { ActiveForm } from '../forms/active.ts';
import { catalogModels } from '../forms/shared.ts';
import {
  blankCell,
  blankGrid,
  cleanValues,
  type ExistingGrid,
  type GridCombo,
  type GridState,
  gridCellInputs,
  gridCombos,
  gridProductInputs,
  loadGrid,
  planGridSave,
  skuCode,
} from '../forms/variantGrid.ts';
import type { VariantGridForm } from '../recipes/types.ts';
import FieldInput from './FieldInput.svelte';

interface VariantGridFormProps {
  active: ActiveForm<VariantGridForm>;
  /** The product to edit; omitted when creating. */
  id?: string;
  onsaved: () => void;
  oncancel: () => void;
}

let { active, id, onsaved, oncancel }: VariantGridFormProps = $props();

const source = useDataSource();
const productInputs = $derived(gridProductInputs(active, catalogModels));
const cellInputs = $derived(gridCellInputs(active, catalogModels));

// svelte-ignore state_referenced_locally
let grid = $state<GridState>(blankGrid(active, catalogModels));
let existing = $state<ExistingGrid | undefined>(undefined);
// svelte-ignore state_referenced_locally
let loaded = $state(id === undefined);
let error = $state('');

async function load(productId: string) {
  const found = await loadGrid(source, active, catalogModels, productId);
  if (found) {
    grid = found.state;
    existing = found.existing;
  }
  loaded = true;
}
// svelte-ignore state_referenced_locally
if (id !== undefined) void load(id);

const combos = $derived(gridCombos(active.form, grid));
/** Axes with values: a matrix needs exactly two. */
const usedAxes = $derived(
  active.form.axes.filter(
    (axis) => cleanValues(grid.axes[axis.name] ?? []).length,
  ),
);
const matrix = $derived(usedAxes.length === 2);
const rowAxis = $derived(usedAxes[0]);
const colAxis = $derived(usedAxes[1]);
const rowValues = $derived(cleanValues(grid.axes[rowAxis?.name ?? ''] ?? []));
const colValues = $derived(cleanValues(grid.axes[colAxis?.name ?? ''] ?? []));
const comboByKey = $derived(new Map(combos.map((c) => [c.key, c])));
const productName = $derived(grid.values.name);

const keyOf = (...values: string[]) => JSON.stringify(values);
const labelOf = (combo: GridCombo) => combo.values.join(' ');

function cellValue(key: string, fieldId: string): unknown {
  return grid.cells[key]?.[fieldId];
}

function setCell(key: string, fieldId: string, value: number | null) {
  grid.cells[key] = {
    ...blankCell(active, catalogModels),
    ...(grid.cells[key] ?? {}),
    [fieldId]: value,
  };
}

function numberFrom(raw: string): number | null {
  if (raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function save(event: SubmitEvent) {
  event.preventDefault();
  error = '';
  if (combos.length === 0) {
    error = 'Add at least one value to sell, such as a size or a color.';
    return;
  }
  try {
    await source.apply(planGridSave(active, catalogModels, grid, existing));
    onsaved();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Could not save.';
  }
}
</script>

{#snippet cellInput(combo: GridCombo)}
  {#each cellInputs as { field } (field.id)}
    <input
      type="number"
      min="0"
      step="1"
      aria-label={`${field.label}, ${labelOf(combo)}`}
      onfocus={(event) => event.currentTarget.select()}
      value={cellValue(combo.key, field.id) ?? ''}
      oninput={(event) =>
        setCell(combo.key, field.id, numberFrom(event.currentTarget.value))}
    />
  {:else}
    <span class="sku">{skuCode(productName, combo)}</span>
  {/each}
{/snippet}

{#if !loaded}
  <p>Loading...</p>
{:else}
  <form onsubmit={save}>
    <h3>{id === undefined ? `New ${active.form.label.toLowerCase()}` : `Edit ${active.form.label.toLowerCase()}`}</h3>
    {#each productInputs as { field, catalogField } (field.id)}
      <FieldInput
        field={{ ...catalogField, required: field.required ?? catalogField.required }}
        label={field.label}
        help={field.help}
        idPrefix={active.form.id}
        value={grid.values[field.id]}
        onchange={(value) => (grid.values[field.id] = value)}
      />
    {/each}

    {#each active.form.axes as axis (axis.name)}
      <TagsInput
        label={axis.label}
        placeholder={`Add a ${axis.label.replace(/s$/i, '').toLowerCase()}`}
        values={grid.axes[axis.name] ?? []}
        onvalueschange={(values) => (grid.axes[axis.name] = cleanValues(values))}
      />
    {/each}

    <div class="grid" role="group" aria-labelledby={`${active.form.id}-grid`}>
      <h4 id={`${active.form.id}-grid`}>
        {usedAxes.map((a, i) => (i === 0 ? a.label : a.label.toLowerCase())).join(' by ') || 'Combinations'}
        <small>
          {combos.length} {combos.length === 1 ? 'combination' : 'combinations'}, one
          SKU each{cellInputs.length ? `, with ${cellInputs.map((c) => c.field.label.toLowerCase()).join(' and ')} for each` : ''}
        </small>
      </h4>
      {#if combos.length === 0}
        <p class="meta">Add sizes or colors above to build the grid.</p>
      {:else if matrix && rowAxis && colAxis}
        <div class="scroll">
          <table>
            <caption class="visually-hidden">
              {rowAxis.label} by {colAxis.label.toLowerCase()}
            </caption>
            <thead>
              <tr>
                <td><span class="visually-hidden">{rowAxis.label}</span></td>
                {#each colValues as color (color)}
                  <th scope="col">{color}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each rowValues as size (size)}
                <tr>
                  <th scope="row">{size}</th>
                  {#each colValues as color (color)}
                    {@const combo = comboByKey.get(keyOf(size, color))}
                    <td>{#if combo}{@render cellInput(combo)}{/if}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="scroll">
          <table>
            <caption class="visually-hidden">Combinations</caption>
            <thead>
              <tr>
                {#each usedAxes as axis (axis.name)}
                  <th scope="col">{axis.label}</th>
                {/each}
                <th scope="col">{cellInputs.length ? cellInputs.map((c) => c.field.label).join(', ') : 'SKU'}</th>
              </tr>
            </thead>
            <tbody>
              {#each combos as combo (combo.key)}
                <tr>
                  {#each combo.values as value, i (i)}
                    <th scope="row">{value}</th>
                  {/each}
                  <td>{@render cellInput(combo)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="actions">
      <button type="submit">Save</button>
      <button type="button" class="secondary" onclick={oncancel}>Cancel</button>
    </div>
  </form>
{/if}

<style>
  form {
    display: grid;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  h3,
  h4,
  p {
    margin: 0;
  }

  small,
  .meta,
  .sku {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 400;
  }

  .grid {
    display: grid;
    gap: var(--smrt-spacing-2);
  }

  .scroll {
    overflow-x: auto;
  }

  table {
    border-collapse: collapse;
  }

  th,
  td {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    border: 1px solid var(--smrt-color-outline-variant);
    text-align: left;
  }

  td input {
    width: 6rem;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
  }

  .sku {
    font-size: 0.85rem;
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  .error {
    color: var(--smrt-color-error);
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
