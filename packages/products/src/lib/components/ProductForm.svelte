<script lang="ts">
import type { ProductData } from '../types';

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

function _handleSubmit(event: Event) {
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

<form onsubmit={handleSubmit} class="product-form">
  <div class="form-group">
    <label for="name">Product Name *</label>
    <input
      id="name"
      type="text"
      bind:value={formData.name}
      disabled={loading}
      class="form-input"
      class:error={errors.name}
      placeholder="Enter product name"
    />
    {#if errors.name}
      <span class="error-message">{errors.name}</span>
    {/if}
  </div>

  <div class="form-group">
    <label for="description">Description</label>
    <textarea
      id="description"
      bind:value={formData.description}
      disabled={loading}
      class="form-textarea"
      placeholder="Product description (optional)"
      rows="3"
    ></textarea>
  </div>

  <div class="form-row">
    <div class="form-group">
      <label for="price">Price *</label>
      <input
        id="price"
        type="number"
        step="0.01"
        min="0"
        bind:value={formData.price}
        disabled={loading}
        class="form-input"
        class:error={errors.price}
        placeholder="0.00"
      />
      {#if errors.price}
        <span class="error-message">{errors.price}</span>
      {/if}
    </div>

    <div class="form-group">
      <label for="category">Category</label>
      <input
        id="category"
        type="text"
        bind:value={formData.category}
        disabled={loading}
        class="form-input"
        placeholder="Product category"
      />
    </div>
  </div>

  <div class="form-group">
    <label for="tags">Tags</label>
    <input
      id="tags"
      type="text"
      bind:value={formData.tags}
      disabled={loading}
      class="form-input"
      placeholder="tag1, tag2, tag3"
    />
    <small class="form-hint">Separate tags with commas</small>
  </div>

  <div class="form-group">
    <label class="checkbox-label">
      <input
        type="checkbox"
        bind:checked={formData.inStock}
        disabled={loading}
        class="form-checkbox"
      />
      In Stock
    </label>
  </div>

  <div class="form-actions">
    {#if onCancel}
      <button type="button" onclick={onCancel} disabled={loading} class="cancel-btn">
        Cancel
      </button>
    {/if}
    
    <button type="submit" disabled={loading} class="submit-btn">
      {#if loading}
        Saving...
      {:else}
        {product.id ? 'Update Product' : 'Create Product'}
      {/if}
    </button>
  </div>
</form>

<style>
  .product-form {
    max-width: 500px;
    padding: 1.5rem;
    background: white;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
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
    font-weight: 500;
    color: #374151;
    font-size: 0.875rem;
  }
  
  .form-input, .form-textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.875rem;
    transition: border-color 0.2s;
  }
  
  .form-input:focus, .form-textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }
  
  .form-input.error {
    border-color: #dc2626;
  }
  
  .form-textarea {
    resize: vertical;
    min-height: 80px;
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
    color: #6b7280;
    font-size: 0.75rem;
    margin-top: 0.25rem;
  }
  
  .error-message {
    color: #dc2626;
    font-size: 0.75rem;
    margin-top: 0.25rem;
    display: block;
  }
  
  .form-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid #f3f4f6;
  }
  
  .cancel-btn, .submit-btn {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid;
    transition: all 0.2s;
  }
  
  .cancel-btn {
    background: white;
    border-color: #d1d5db;
    color: #374151;
  }
  
  .cancel-btn:hover:not(:disabled) {
    background: #f9fafb;
  }
  
  .submit-btn {
    background: #3b82f6;
    border-color: #3b82f6;
    color: white;
  }
  
  .submit-btn:hover:not(:disabled) {
    background: #2563eb;
  }
  
  .submit-btn:disabled, .cancel-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>