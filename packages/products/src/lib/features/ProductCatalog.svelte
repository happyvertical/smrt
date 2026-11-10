<script lang="ts">
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import ProductCard from '../components/ProductCard.svelte';
import ProductForm from '../components/ProductForm.svelte';
import { M } from '../i18n.js';
import { productStore } from '../stores/product-store.svelte';
import type { ProductData } from '../types';

const { t } = useI18n();

interface Props {
  readonly?: boolean;
  showCreateForm?: boolean;
}

const { readonly = false, showCreateForm = false }: Props = $props();

let searchQuery = $state('');
let selectedCategory = $state('');
let showForm = $state(false);
let editingProduct = $state<ProductData | null>(null);

// Reactive filtered products
const filteredProducts = $derived.by(() => {
  let products = productStore.items;

  if (searchQuery) {
    products = productStore.searchProducts(searchQuery);
  }

  if (selectedCategory) {
    products = products.filter((p) => p.category === selectedCategory);
  }

  return products;
});

onMount(() => {
  productStore.loadProducts();
});

function handleCreateProduct() {
  editingProduct = null;
  showForm = true;
}

function handleEditProduct(product: ProductData) {
  editingProduct = product;
  showForm = true;
}

async function handleDeleteProduct(id: string) {
  if (confirm('Are you sure you want to delete this product?')) {
    try {
      await productStore.deleteProduct(id);
    } catch {
      // deleteProduct already recorded the message on productStore.error;
      // the error region below renders it. Swallow the re-thrown
      // rejection so it doesn't become an unhandled promise rejection.
    }
  }
}

async function handleSubmitProduct(productData: Partial<ProductData>) {
  try {
    if (editingProduct?.id) {
      await productStore.updateProduct(editingProduct.id, productData);
    } else {
      await productStore.createProduct(productData);
    }
    showForm = false;
    editingProduct = null;
  } catch {
    // Keep the form open on failure; productStore.error holds the message
    // and the error region renders it.
  }
}

function handleCancelForm() {
  showForm = false;
  editingProduct = null;
}
</script>

<div class="smrt-product-catalog__root" data-smrt-component="ProductCatalog">
  <div class="smrt-product-catalog__header" data-smrt-part="header">
    <h2>{t(M['products.product_catalog.title'])}</h2>
    
    <div class="smrt-product-catalog__stats" data-smrt-part="meta">
      <span class="smrt-product-catalog__stat" data-smrt-part="item">
        <strong>{productStore.items.length}</strong> products
      </span>
      <span class="smrt-product-catalog__stat" data-smrt-part="item">
        <strong>{productStore.inStockCount}</strong> {t(M['products.product_catalog.in_stock'])}
      </span>
      <span class="smrt-product-catalog__stat" data-smrt-part="item">
        {t(M['products.product_catalog.total_value'])} <strong>${productStore.totalValue.toFixed(2)}</strong>
      </span>
    </div>
  </div>
  
  <div class="smrt-product-catalog__controls" data-smrt-part="toolbar">
    <div class="smrt-product-catalog__filters" data-smrt-part="group">
      <Input
        type="text"
        bind:value={searchQuery}
        placeholder={t(M['products.product_catalog.search_placeholder'])}
        aria-label={t(M['products.product_catalog.search_placeholder'])}
        class="smrt-product-catalog__search-input"
      />

      <Select bind:value={selectedCategory} class="smrt-product-catalog__category-filter">
        <option value="">{t(M['products.product_catalog.all_categories'])}</option>
        {#each productStore.categories as category}
          <option value={category}>{category}</option>
        {/each}
      </Select>
    </div>
    
    {#if !readonly && (showCreateForm || productStore.items.length === 0)}
      <Button
        type="button"
        variant="primary"
        onclick={handleCreateProduct}
      >
        {t(M['products.product_catalog.add_product'])}
      </Button>
    {/if}
  </div>
  
  {#if productStore.loading}
    <div class="smrt-product-catalog__loading" data-smrt-part="status" role="status" aria-live="polite">
      <p>{t(M['products.product_catalog.loading'])}</p>
    </div>
  {:else if productStore.error}
    <div class="smrt-product-catalog__error" data-smrt-part="error" role="alert" aria-live="assertive">
      <p>Error: {productStore.error}</p>
      <Button type="button" variant="danger" onclick={() => productStore.loadProducts()}>
        Retry
      </Button>
    </div>
  {:else if filteredProducts.length === 0}
    <div class="smrt-product-catalog__empty" data-smrt-part="empty" role="status" aria-live="polite">
      {#if productStore.items.length === 0}
        <p>{t(M['products.product_catalog.empty'])}</p>
        {#if !readonly}
          <Button type="button" variant="primary" onclick={handleCreateProduct}>
            {t(M['products.product_catalog.create_first'])}
          </Button>
        {/if}
      {:else}
        <p>{t(M['products.product_catalog.no_match'])}</p>
      {/if}
    </div>
  {:else}
    <div class="smrt-product-catalog__grid" data-smrt-part="list">
      {#each filteredProducts as product (product.id)}
        <ProductCard 
          {product}
          onEdit={readonly ? undefined : handleEditProduct}
          onDelete={readonly ? undefined : handleDeleteProduct}
        />
      {/each}
    </div>
  {/if}
  
  {#if showForm && !readonly}
    <div class="smrt-product-catalog__overlay" data-smrt-part="overlay">
      <div class="smrt-product-catalog__form-container" data-smrt-part="panel">
        <h3>{editingProduct ? 'Edit Product' : 'Create New Product'}</h3>
        <ProductForm
          product={editingProduct ?? undefined}
          onSubmit={handleSubmitProduct}
          onCancel={handleCancelForm}
          loading={productStore.loading}
        />
      </div>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-product-catalog__root {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
  }
  .smrt-product-catalog__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
  }
  .smrt-product-catalog__header h2 {
    margin: 0;
  }
  .smrt-product-catalog__stats {
    display: flex;
    gap: 1.5rem;
  }
  .smrt-product-catalog__controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    gap: 1rem;
  }
  .smrt-product-catalog__filters {
    display: flex;
    gap: 0.75rem;
    flex: 1;
  }
  /* Layout sizing for the migrated <Input>/<Select>. The primitives own their
  inner elements, so target them through the component hooks to keep the
  flex sizing the old scoped rules supplied (#1589); padding/border/font come
  from the primitives' tokenised styling now. */
  .smrt-product-catalog__filters :global([data-smrt-component="Input"]) {
    flex: 1;
    max-width: 300px;
  }
  .smrt-product-catalog__filters :global([data-smrt-component="Select"]) {
    min-width: 150px;
  }
  .smrt-product-catalog__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
  }
  .smrt-product-catalog__loading, .smrt-product-catalog__error, .smrt-product-catalog__empty {
    padding: 3rem 1rem;
  }
  /* Restore the retry button's spacing from the error message. The old
  `.smrt-product-catalog__error button` rule can't reach the <button> rendered inside the
  smrt-ui <Button>, so pierce into it with `:global` (#1589); the danger
  variant already supplies the background/color the old rule set. */
  .smrt-product-catalog__error :global([data-smrt-component="Button"]) {
    margin-top: 0.5rem;
  }
  .smrt-product-catalog__overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--smrt-z-index-dialog, 1300);
  }
  .smrt-product-catalog__form-container {
    max-width: 500px;
    width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
  }
  .smrt-product-catalog__form-container h3 {
    margin: 0 0 1rem 0;
    padding: 1.5rem 1.5rem 0 1.5rem;
  }
}

@layer smrt.theme {
  .smrt-product-catalog__header {
    border-bottom: 2px solid var(--smrt-color-outline-variant);
  }
  .smrt-product-catalog__header h2 {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-headline-large-size, 1.875rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-product-catalog__stats {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-product-catalog__loading, .smrt-product-catalog__error, .smrt-product-catalog__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-product-catalog__overlay {
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.5));
  }
  .smrt-product-catalog__form-container {
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-product-catalog__form-container h3 {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
}

</style>