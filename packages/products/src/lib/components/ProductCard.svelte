<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ProductData } from '../types';

interface Props {
  /** The product to display. */
  product: ProductData;
  /** Fired when the user clicks to edit the product. */
  onEdit?: (product: ProductData) => void;
  /** Fired when the user clicks to delete the product. */
  onDelete?: (id: string) => void;
}

const { product, onEdit, onDelete }: Props = $props();
</script>

<div class="smrt-product-card__root" data-smrt-component="ProductCard">
  <div class="smrt-product-card__header" data-smrt-part="header">
    <h3 class="smrt-product-card__name" data-smrt-part="title">{product.name}</h3>
    {#if product.manufacturer}
      <div class="smrt-product-card__manufacturer" data-smrt-part="meta">{product.manufacturer}</div>
    {/if}
  </div>

  {#if product.model}
    <div class="smrt-product-card__model" data-smrt-part="meta">Model: {product.model}</div>
  {/if}

  {#if product.description}
    <p class="smrt-product-card__description" data-smrt-part="body">{product.description}</p>
  {/if}

  <div class="smrt-product-card__meta" data-smrt-part="group">
    {#if product.category}
      <div class="smrt-product-card__category" data-smrt-part="badge">Category: {product.category}</div>
    {/if}
    
    {#if product.tags && product.tags.length > 0}
      <div class="smrt-product-card__tags" data-smrt-part="list">
        {#each product.tags as tag}
          <span class="smrt-product-card__tag" data-smrt-part="item">{tag}</span>
        {/each}
      </div>
    {/if}
  </div>
  
  <div class="smrt-product-card__actions" data-smrt-part="actions">
    {#if onEdit}
      <Button type="button" variant="secondary" size="sm" onclick={() => onEdit?.(product)}>
        Edit
      </Button>
    {/if}

    {#if onDelete}
      <Button type="button" variant="danger" size="sm" onclick={() => product.id && onDelete?.(product.id)}>
        Delete
      </Button>
    {/if}
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-product-card__root {
    padding: 1rem;
  }
  .smrt-product-card__header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.5rem;
  }
  .smrt-product-card__name {
    margin: 0;
  }
  .smrt-product-card__model {
    margin-bottom: 0.5rem;
  }
  .smrt-product-card__category {
    padding: 0.25rem 0.5rem;
    display: inline-block;
    margin-bottom: 0.5rem;
  }
  .smrt-product-card__description {
    margin: 0.5rem 0;
  }
  .smrt-product-card__meta {
    margin: 0.75rem 0;
  }
  .smrt-product-card__tags {
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .smrt-product-card__tag {
    padding: 0.125rem 0.5rem;
  }
  .smrt-product-card__actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    padding-top: 0.75rem;
  }
}

@layer smrt.theme {
  .smrt-product-card__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
    background: var(--smrt-color-surface);
    box-shadow: var(--smrt-elevation-1, 0 1px 3px color-mix(in srgb, var(--smrt-color-shadow) 10%, transparent));
    transition: box-shadow 0.2s;
  }
  .smrt-product-card__root:hover {
    box-shadow: var(--smrt-elevation-2, 0 4px 6px color-mix(in srgb, var(--smrt-color-shadow) 10%, transparent));
  }
  .smrt-product-card__name {
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-product-card__manufacturer {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-product-card__model {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-product-card__category {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-product-card__description {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    line-height: var(--smrt-typography-body-medium-line-height, 1.4);
  }
  .smrt-product-card__tag {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  .smrt-product-card__actions {
    border-top: var(--smrt-hairline);
  }
}

</style>