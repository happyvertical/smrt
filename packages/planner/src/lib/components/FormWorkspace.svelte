<script lang="ts">
import { page } from '$app/state';
import type { CatalogModel } from '../catalog/types.ts';
import { useDataSource } from '../data/context.ts';
import { createNoun, formatMoney, recordCount } from '../data/format.ts';
import {
  type ListSort,
  nextListSort,
  sortListRows,
} from '../data/list-sort.ts';
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
import { takeCreate } from '../planner/create.ts';
import {
  ASSET,
  PRODUCT_ASSET,
  type ProductImage,
  planProductImageSave,
  productImages,
} from '../products/media.ts';
import { inScope, type RowScope } from '../recipes/scope.ts';
import '../styles/planner-lists.css';
import FieldMapForm from './FieldMapForm.svelte';
import ProductMedia from './ProductMedia.svelte';
import VariantGridForm from './VariantGridForm.svelte';

interface FormWorkspaceProps {
  model: CatalogModel;
  /** The forms of the added recipes for this model; New offers each. */
  forms: ActiveForm[];
  /** The slice of rows this page lists (a filtered nav entry), if any. */
  scope?: RowScope;
  /** Values a new row carries so it stays in `scope`. */
  preset?: Record<string, unknown>;
  /** The list's heading; defaults to the model's plural name. */
  title?: string;
  /** What New creates on a filtered page, e.g. "ingredient". */
  noun?: string;
}

let { model, forms, scope, preset, title, noun }: FormWorkspaceProps = $props();

const source = useDataSource();
const showStock = $derived(forms.some((f) => extendsWith(f, STOCK_LEVEL)));
/** A filtered page adds plain products only; a grid of variants has no place there. */
const offered = $derived(
  scope?.equals !== undefined ? forms.filter(isFieldMap) : forms,
);
const gridForm = $derived(forms.find(isVariantGrid));
const mapForm = $derived(forms.find(isFieldMap));

let rows = $state<ModelRecord[]>([]);
let sort = $state<ListSort | null>(null);
let withAxes = $state(new Set<string>());
let stock = $state(new Map<string, number>());
let images = $state(new Map<string, ProductImage[]>());
let productAssets = $state<ModelRecord[]>([]);
let loaded = $state(false);
/** The form open, and the row it edits (none when creating). */
let editing = $state<{ form: ActiveForm; id?: string } | null>(null);
/** Bumped each time a form opens so it remounts with fresh state. */
let formKey = $state(0);

async function load() {
  rows = (await source.list(model)).filter((row) => inScope(scope, row));
  // Rows with axes are Clothing even when its recipe is off.
  const variants = await source.list(catalogModels(VARIANT));
  withAxes = new Set(variants.map((v) => String(v.productId)));
  stock = showStock
    ? stockByProduct(
        await source.list(catalogModels(SKU)),
        await source.list(catalogModels(STOCK_LEVEL)),
      )
    : new Map();
  const [assets, associations] = await Promise.all([
    source.list(catalogModels(ASSET)),
    source.list(catalogModels(PRODUCT_ASSET)),
  ]);
  productAssets = associations;
  images = new Map(
    rows.map((row) => [row.id, productImages(row.id, assets, associations)]),
  );
  loaded = true;
}

$effect(() => {
  // Reload (and close any open form) when the model or the forms change.
  model.id;
  forms;
  scope;
  sort = null;
  editing = null;
  loaded = false;
  void load().then(() => {
    // A section page's "New ..." arrives with the form already open.
    const first = offered[0];
    if (takeCreate(page.url.pathname) && first) open(first);
  });
});

// A reset (a cookbook applied, the app reset) swaps the rows underneath an
// open page: read them again rather than keep showing the old ones.
$effect(() => source.onReset?.(() => void load()));

/** A row is Clothing when it has axes, Simple otherwise. */
const kindOf = (row: ModelRecord): ActiveForm | undefined =>
  withAxes.has(row.id) ? gridForm : mapForm;

const kindLabel = (row: ModelRecord): string =>
  kindOf(row)?.form.kindLabel ?? (withAxes.has(row.id) ? 'Clothing' : 'Simple');

const sortedRows = $derived(
  sortListRows(rows, sort, (row, key) => {
    switch (key) {
      case 'name':
        return row.name;
      case 'kind':
        return kindLabel(row);
      case 'price':
        return row.price;
      case 'stock':
        return stock.get(row.id);
      default:
        return undefined;
    }
  }),
);

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
  await source.apply(
    planProductDelete(row.id, skus, catalogModels, productAssets),
  );
  await load();
}

async function addImage(row: ModelRecord, file: File) {
  const sourceUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error('Could not read image.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  await source.apply(
    planProductImageSave(
      row.id,
      file,
      sourceUri,
      images.get(row.id)?.length ?? 0,
    ),
  );
  await load();
}
</script>

<section>
  <header>
    <h2>{title ?? (model.name === 'Product' ? 'Products' : model.name)} {#if loaded}<small>{recordCount(rows.length)}</small>{/if}</h2>
    <div class="new">
      {#each offered as active (active.form.id)}
        <button type="button" onclick={() => open(active)}>
          New {createNoun(active.form.label, noun, scope?.equals !== undefined || offered.length === 1)}
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
          {preset}
          noun={offered.length === 1 ? noun : undefined}
          onsaved={saved}
          oncancel={() => (editing = null)}
        />
      {/if}
    {/key}
  {/if}

  {#if !loaded}
    <p>Loading sample data...</p>
  {:else if rows.length === 0}
    <p>No records yet. Create one above.</p>
  {:else}
    <ProductMedia rows={rows} {images} onselect={addImage} />
    <div class="scroll">
      <table class="planner-list">
        <thead>
          <tr>
            {#each [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'price', label: 'Price' }, ...(showStock ? [{ key: 'stock', label: 'Stock' }] : [])] as column (column.key)}
              <th scope="col" aria-sort={sort?.key === column.key ? sort.direction : 'none'}>
                <button type="button" class="sort-button" onclick={() => (sort = nextListSort(sort, column.key))}>
                  {column.label}<span class="sort-icon" aria-hidden="true">{sort?.key === column.key ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'}</span>
                </button>
              </th>
            {/each}
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each sortedRows as row (row.id)}
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
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
    border-bottom: var(--smrt-hairline);
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
