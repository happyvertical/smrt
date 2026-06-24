<script lang="ts">
import { Form, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { ProductData } from '../types';

const { t } = useI18n();

interface Props {
  product?: Partial<ProductData>;
  onSubmit: (product: Partial<ProductData>) => void;
  onCancel?: () => void;
  loading?: boolean;
}

const { product = {}, onSubmit, onCancel, loading = false }: Props = $props();

const formData = $state({
  name: product.name || '',
  description: product.description || '',
  price: product.price || 0,
  inStock: product.inStock ?? true,
  category: product.category || '',
  tags: product.tags?.join(', ') || '',
});

let errors = $state<Record<string, string>>({});

function validateForm() {
  errors = {};

  if (!formData.name.trim()) {
    errors.name = 'Product name is required';
  }

  if (formData.price < 0) {
    errors.price = 'Price must be non-negative';
  }

  return Object.keys(errors).length === 0;
}

function handleSubmit(event: Event) {
  event.preventDefault();

  if (!validateForm()) {
    return;
  }

  const productData: Partial<ProductData> = {
    ...product,
    name: formData.name.trim(),
    description: formData.description.trim() || undefined,
    price: formData.price,
    inStock: formData.inStock,
    category: formData.category.trim(),
    tags: formData.tags
      ? formData.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      : [],
  };

  onSubmit(productData);
}
</script>

<div class="product-form-shell">
  <Form onsubmit={handleSubmit} class="product-form">
    <div class="form-group">
      <label for="name">{t(M['products.product_form.name_label'])}</label>
      <Input
        id="name"
        type="text"
        bind:value={formData.name}
        disabled={loading}
        class={errors.name ? 'error' : ''}
        placeholder={t(M['products.product_form.name_placeholder'])}
      />
      {#if errors.name}
        <span class="error-message">{errors.name}</span>
      {/if}
    </div>

    <div class="form-group">
      <label for="description">Description</label>
      <Textarea
        id="description"
        bind:value={formData.description}
        disabled={loading}
        placeholder={t(M['products.product_form.description_placeholder'])}
        rows={3}
      ></Textarea>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="price">Price *</label>
        <Input
          id="price"
          type="number"
          step="0.01"
          min="0"
          bind:value={formData.price}
          disabled={loading}
          class={errors.price ? 'error' : ''}
          placeholder="0.00"
        />
        {#if errors.price}
          <span class="error-message">{errors.price}</span>
        {/if}
      </div>

      <div class="form-group">
        <label for="category">Category</label>
        <Input
          id="category"
          type="text"
          bind:value={formData.category}
          disabled={loading}
          placeholder={t(M['products.product_form.category_placeholder'])}
        />
      </div>
    </div>

    <div class="form-group">
      <label for="tags">Tags</label>
      <Input
        id="tags"
        type="text"
        bind:value={formData.tags}
        disabled={loading}
        placeholder={t(M['products.product_form.tags_placeholder'])}
      />
      <small class="form-hint">{t(M['products.product_form.tags_hint'])}</small>
    </div>

    <div class="form-group">
      <label class="checkbox-label">
        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
        <input
          type="checkbox"
          bind:checked={formData.inStock}
          disabled={loading}
          class="form-checkbox"
        />
        {t(M['products.product_form.in_stock_label'])}
      </label>
    </div>

    <div class="form-actions">
      {#if onCancel}
        <Button type="button" variant="secondary" onclick={onCancel} disabled={loading}>
          Cancel
        </Button>
      {/if}

      <Button type="submit" variant="primary" disabled={loading}>
        {#if loading}
          Saving...
        {:else}
          {product.id ? 'Update Product' : 'Create Product'}
        {/if}
      </Button>
    </div>
  </Form>
</div>

<style>
  .product-form-shell :global(.product-form) {
    max-width: 500px;
    padding: 1.5rem;
    background: var(--smrt-color-surface, #fff);
    border-radius: var(--smrt-radius-md, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
  }

  .form-group {
    margin-bottom: 1rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  label {
    display: block;
    margin-bottom: 0.25rem;
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface, #374151);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }

  /* Error border on the migrated <Input>. The primitive renders the inner
     <input class="input error"> inside its own component, so the scoped class
     can't reach it without :global (#1589). */
  .product-form-shell :global(.input.error) {
    border-color: var(--smrt-color-error, #dc2626);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  
  .form-checkbox {
    width: auto;
  }
  
  .form-hint {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    margin-top: 0.25rem;
  }

  .error-message {
    color: var(--smrt-color-error, #dc2626);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    margin-top: 0.25rem;
    display: block;
  }

  .form-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--smrt-color-outline-variant, #f3f4f6);
  }
</style>