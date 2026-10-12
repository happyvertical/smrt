<script lang="ts">
import { AssetGrid } from '@happyvertical/smrt-assets/svelte';
import { FilePicker } from '@happyvertical/smrt-ui/forms';
import type { ComponentProps } from 'svelte';
import type { ModelRecord } from '../data/source.ts';
import { GALLERY_RECIPE, type ProductImage } from '../products/media.ts';
import { recipeState } from '../recipes/state.svelte.ts';

type GridAsset = ComponentProps<typeof AssetGrid>['assets'][number];

interface ProductMediaProps {
  rows: readonly ModelRecord[];
  images: ReadonlyMap<string, readonly ProductImage[]>;
  onselect: (product: ModelRecord, file: File) => void;
}

let { rows, images, onselect }: ProductMediaProps = $props();
// The gallery is configured in the cookbook: it follows the Asset library recipe.
const gallery = $derived(recipeState.has(GALLERY_RECIPE));
let selectedIds = $state(new Set<string>());

/** ProductAsset-linked images in the shape the canonical asset grid renders. */
function gridAssets(list: readonly ProductImage[]): GridAsset[] {
  return list.map(
    (image) =>
      ({
        id: image.id,
        name: image.name,
        sourceUri: image.sourceUri,
        mimeType: image.mimeType,
        description: image.description,
      }) as unknown as GridAsset,
  );
}

function toggle(asset: GridAsset) {
  const next = new Set(selectedIds);
  if (!next.delete(asset.id)) next.add(asset.id);
  selectedIds = next;
}

const nameOf = (product: ModelRecord) =>
  String(product.name ?? 'Untitled product');
</script>

<section class="media" aria-label="Product images">
  <div class="heading">
    <h3>Product images</h3>
    <p>Images stay in this browser demo and are linked through ProductAsset.</p>
    {#if !gallery}
      <p>Add the Asset library recipe to show the product gallery.</p>
    {/if}
  </div>

  <ul class="products">
    {#each rows as product (product.id)}
      {@const productImages = images.get(product.id) ?? []}
      <li>
        <strong>{nameOf(product)}</strong>
        {#if gallery}
          <AssetGrid
            assets={gridAssets(productImages)}
            {selectedIds}
            onSelectionChange={(ids) => (selectedIds = ids)}
            onAssetClick={toggle}
            mode="pick"
          />
        {:else}
          <span class="count">
            {productImages.length}
            {productImages.length === 1 ? 'image' : 'images'}
          </span>
        {/if}
        <FilePicker
          label={`Add image for ${nameOf(product)}`}
          accept="image/*"
          onchangefiles={(files) => {
            if (files[0]) onselect(product, files[0]);
          }}
        />
      </li>
    {/each}
  </ul>
</section>

<style>
  .media, .heading, li { display: grid; gap: var(--smrt-spacing-2); }
  h3, p { margin: 0; }
  p, .count { color: var(--smrt-color-on-surface-variant); }
  .products { display: grid; gap: var(--smrt-spacing-3); margin: 0; padding: 0; list-style: none; }
  li { padding: var(--smrt-spacing-2); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); }
</style>
