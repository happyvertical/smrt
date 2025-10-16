<script lang="ts">
import { onMount } from 'svelte';
import { productStore } from '$lib/stores/product-store.svelte';
import type { ProductData } from '../types';

interface Props {
  readonly?: boolean;
  showCreateForm?: boolean;
}

const { readonly = false, showCreateForm = false }: Props = $props();

const searchQuery = $state('');
const selectedCategory = $state('');
let _showForm = $state(false);
let editingProduct = $state<ProductData | null>(null);

// Reactive filtered products
const _filteredProducts = $derived.by(() => {
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

function _handleCreateProduct() {
  editingProduct = null;
  _showForm = true;
}

function _handleEditProduct(product: ProductData) {
  editingProduct = product;
  _showForm = true;
}

async function _handleDeleteProduct(id: string) {
  if (confirm('Are you sure you want to delete this product?')) {
    try {
      await productStore.deleteProduct(id);
    } catch (error) {
      console.error('Failed to delete product:', error);
    }
  }
}

async function _handleSubmitProduct(productData: Partial<ProductData>) {
  try {
    if (editingProduct) {
      await productStore.updateProduct(editingProduct.id!, productData);
    } else {
      await productStore.createProduct(productData);
    }
    _showForm = false;
    editingProduct = null;
  } catch (error) {
    console.error('Failed to save product:', error);
  }
}

function _handleCancelForm() {
  _showForm = false;
  editingProduct = null;
}
</script>

<div class="product-catalog">
  <div class="catalog-header">
    <h2>Product Catalog</h2>
    
    <div class="catalog-stats">
      <span class="stat">
        <strong>{productStore.items.length}</strong> products
      </span>
      <span class="stat">
        <strong>{productStore.inStockCount}</strong> in stock
      </span>
      <span class="stat">
        Total value: <strong>${productStore.totalValue.toFixed(2)}</strong>
      </span>
    </div>
  </div>
  
  <div class="catalog-controls">
    <div class="search-filters">
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Search products..."
        class="search-input"
      />
      
      <select bind:value={selectedCategory} class="category-filter">
        <option value="">All Categories</option>
        {#each productStore.categories as category}
          <option value={category}>{category}</option>
        {/each}
      </select>
    </div>
    
    {#if !readonly && (showCreateForm || productStore.items.length === 0)}
      <button 
        type="button" 
        onclick={handleCreateProduct}
        class="create-btn"
      >
        Add Product
      </button>
    {/if}
  </div>
  
  {#if productStore.loading}
    <div class="loading-state">
      <p>Loading products...</p>
    </div>
  {:else if productStore.error}
    <div class="error-state">
      <p>Error: {productStore.error}</p>
      <button type="button" onclick={() => productStore.loadProducts()}>
        Retry
      </button>
    </div>
  {:else if filteredProducts.length === 0}
    <div class="empty-state">
      {#if productStore.items.length === 0}
        <p>No products yet. Create your first product to get started!</p>
        {#if !readonly}
          <button type="button" onclick={handleCreateProduct} class="create-btn">
            Create First Product
          </button>
        {/if}
      {:else}
        <p>No products match your search criteria.</p>
      {/if}
    </div>
  {:else}
    <div class="products-grid">
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
    <div class="form-overlay">
      <div class="form-container">
        <h3>{editingProduct ? 'Edit Product' : 'Create New Product'}</h3>
        <ProductForm
          product={editingProduct}
          onSubmit={handleSubmitProduct}
          onCancel={handleCancelForm}
          loading={productStore.loading}
        />
      </div>
    </div>
  {/if}
</div>

<style>
  .product-catalog {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem;
  }
  
  .catalog-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 2px solid #e2e8f0;
  }
  
  .catalog-header h2 {
    margin: 0;
    color: #1f2937;
    font-size: 1.875rem;
    font-weight: 700;
  }
  
  .catalog-stats {
    display: flex;
    gap: 1.5rem;
    font-size: 0.875rem;
    color: #6b7280;
  }
  
  .catalog-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
    gap: 1rem;
  }
  
  .search-filters {
    display: flex;
    gap: 0.75rem;
    flex: 1;
  }
  
  .search-input, .category-filter {
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.875rem;
  }
  
  .search-input {
    flex: 1;
    max-width: 300px;
  }
  
  .category-filter {
    min-width: 150px;
  }
  
  .create-btn {
    background: #3b82f6;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  
  .create-btn:hover {
    background: #2563eb;
  }
  
  .products-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
  }
  
  .loading-state, .error-state, .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: #6b7280;
  }
  
  .error-state button {
    margin-top: 0.5rem;
    background: #dc2626;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .form-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  
  .form-container {
    background: white;
    border-radius: 8px;
    max-width: 500px;
    width: 90vw;
    max-height: 90vh;
    overflow-y: auto;
  }
  
  .form-container h3 {
    margin: 0 0 1rem 0;
    padding: 1.5rem 1.5rem 0 1.5rem;
    color: #1f2937;
    font-size: 1.25rem;
    font-weight: 600;
  }
</style>