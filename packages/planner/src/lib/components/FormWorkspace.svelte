<script lang="ts">
import type { CatalogModel } from '../catalog/types.ts';
import { useDataSource } from '../data/context.ts';
import { formatMoney } from '../data/format.ts';
import type { ModelRecord } from '../data/source.ts';
import {
  type ActiveForm,
  extendsWith,
  isFieldMap,
  isVariantGrid,
} from '../forms/active.ts';
import { catalogModels } from '../forms/shared.ts';
import {
  planProductDelete,
  SKU,
  STOCK_LEVEL,
  stockByProduct,
  VARIANT,
} from '../forms/stock.ts';
import FieldMapForm from './FieldMapForm.svelte';
import VariantGridForm from './VariantGridForm.svelte';

interface FormWorkspaceProps {
  model: CatalogModel;
  /** The forms of the added recipes for this model; New offers each. */
  forms: ActiveForm[];
}

let { model, forms }: FormWorkspaceProps = $props();

const source = useDataSource();
const showStock = $derived(forms.some((f) => extendsWith(f, STOCK_LEVEL)));
const gridForm = $derived(forms.find(isVariantGrid));
const mapForm = $derived(forms.find(isFieldMap));

let rows = $state<ModelRecord[]>([]);
let withAxes = $state(new Set<string>());
let stock = $state(new Map<string, number>());
let loaded = $state(false);
/** The form open, and the row it edits (none when creating). */
let editing = $state<{ form: ActiveForm; id?: string } | null>(null);
/** Bumped each time a form opens so it remounts with fresh state. */
let formKey = $state(0);

async function load() {
  rows = await source.list(model);
  // Rows with axes are Clothing even when its recipe is off.
  const variants = await source.list(catalogModels(VARIANT));
  withAxes = new Set(variants.map((v) => String(v.productId)));
  stock = showStock
    ? stockByProduct(
        await source.list(catalogModels(SKU)),
        await source.list(catalogModels(STOCK_LEVEL)),
      )
    : new Map();
  loaded = true;
}

$effect(() => {
  // Reload (and close any open form) when the model or the forms change.
  model.id;
  forms;
  editing = null;
  loaded = false;
  void load();
});

/** A row is Clothing when it has axes, Simple otherwise. */
const kindOf = (row: ModelRecord): ActiveForm | undefined =>
  withAxes.has(row.id) ? gridForm : mapForm;

const kindLabel = (row: ModelRecord): string =>
  kindOf(row)?.form.kindLabel ?? (withAxes.has(row.id) ? 'Clothing' : 'Simple');

function open(form: ActiveForm, id?: string) {
  editing = { form, id };
  formKey++;
}

async function saved() {
  editing = null;
  await load();
}

async function remove(row: ModelRecord) {
  const skus = (await source.list(catalogModels(SKU))).filter(
    (sku) => sku.productId === row.id,
  );
  await source.apply(planProductDelete(row.id, skus, catalogModels));
  await load();
}
</script>

<section>
  <header>
    <h2>{model.name === 'Product' ? 'Products' : model.name} <small>{rows.length} rows</small></h2>
    <div class="new">
      {#each forms as active (active.form.id)}
        <button type="button" onclick={() => open(active)}>
          New {active.form.label.toLowerCase()}
        </button>
      {/each}
    </div>
  </header>

  {#if editing}
    {@const current = editing}
    {#key formKey}
      {#if isVariantGrid(current.form)}
        <VariantGridForm
          active={current.form}
          id={current.id}
          onsaved={saved}
          oncancel={() => (editing = null)}
        />
      {:else if isFieldMap(current.form)}
        <FieldMapForm
          active={current.form}
          id={current.id}
          onsaved={saved}
          oncancel={() => (editing = null)}
        />
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
            <th scope="col">Name</th>
            <th scope="col">Kind</th>
            <th scope="col">Price</th>
            {#if showStock}<th scope="col">Stock</th>{/if}
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            {@const kind = kindOf(row)}
            <tr>
              <td>{row.name}</td>
              <td>{kindLabel(row)}</td>
              <td>{typeof row.price === 'number' ? formatMoney(row.price) : ''}</td>
              {#if showStock}<td>{stock.get(row.id) ?? '–'}</td>{/if}
              <td class="row-actions">
                {#if kind}
                  <button
                    type="button"
                    class="secondary"
                    aria-label={`Edit ${row.name}`}
                    onclick={() => open(kind, row.id)}
                  >
                    Edit
                  </button>
                {/if}
                <button
                  type="button"
                  class="secondary"
                  aria-label={`Delete ${row.name}`}
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
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
    align-items: center;
    justify-content: space-between;
  }

  h2 {
    margin: 0;
  }

  small {
    color: var(--smrt-color-on-surface-variant);
    font-weight: 400;
  }

  .new,
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
