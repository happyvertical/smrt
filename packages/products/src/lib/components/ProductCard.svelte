<script lang="ts">
import type { ProductData } from '../types';

interface Props {
  product: ProductData;
  onEdit?: (product: ProductData) => void;
  onDelete?: (id: string) => void;
}

const { product, onEdit, onDelete }: Props = $props();
</script>

<div class="product-card">
  <div class="product-header">
    <h3 class="product-name">{product.name}</h3>
    {#if product.manufacturer}
      <div class="product-manufacturer">{product.manufacturer}</div>
    {/if}
  </div>

  {#if product.model}
    <div class="product-model">Model: {product.model}</div>
  {/if}

  {#if product.description}
    <p class="product-description">{product.description}</p>
  {/if}

  <div class="product-meta">
    {#if product.category}
      <div class="product-category">Category: {product.category}</div>
    {/if}
    
    {#if product.tags && product.tags.length > 0}
      <div class="product-tags">
        {#each product.tags as tag}
          <span class="tag">{tag}</span>
        {/each}
      </div>
    {/if}
  </div>
  
  <div class="product-actions">
    {#if onEdit}
      <button type="button" onclick={() => onEdit?.(product)} class="edit-btn">
        Edit
      </button>
    {/if}
    
    {#if onDelete}
      <button type="button" onclick={() => onDelete?.(product.id)} class="delete-btn">
        Delete
      </button>
    {/if}
  </div>
</div>

<style>
  .product-card {
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    border-radius: 8px;
    padding: 1rem;
    background: white;
    box-shadow: 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow, #000) 10%, transparent);
    transition: box-shadow 0.2s;
  }

  .product-card:hover {
    box-shadow: 0 4px 6px color-mix(in srgb, var(--smrt-color-shadow, #000) 10%, transparent);
  }
  
  .product-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.5rem;
  }
  
  .product-name {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .product-manufacturer {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .product-model {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin-bottom: 0.5rem;
  }

  .product-category {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--smrt-color-on-surface, #374151);
    background: var(--smrt-color-surface-container, #f3f4f6);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    display: inline-block;
    margin-bottom: 0.5rem;
  }
  
  .product-description {
    margin: 0.5rem 0;
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: 0.875rem;
    line-height: 1.4;
  }
  
  .product-meta {
    margin: 0.75rem 0;
  }
  
  
  .product-tags {
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  
  .tag {
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface, #374151);
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.75rem;
  }

  .product-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--smrt-color-outline-variant, #f3f4f6);
  }
  
  .edit-btn, .delete-btn {
    padding: 0.375rem 0.75rem;
    border-radius: 4px;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid;
    cursor: pointer;
    transition: all 0.2s;
  }
  
  .edit-btn {
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-color: var(--smrt-color-outline-variant, #d1d5db);
    color: var(--smrt-color-on-surface, #374151);
  }

  .edit-btn:hover {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .delete-btn {
    background: var(--smrt-color-error-container, #fef2f2);
    border-color: var(--smrt-color-error, #fecaca);
    color: var(--smrt-color-error, #dc2626);
  }

  .delete-btn:hover {
    background: var(--smrt-color-error-container, #fee2e2);
  }
</style>