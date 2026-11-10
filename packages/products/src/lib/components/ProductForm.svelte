<script lang="ts">
import { Form, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { ProductData } from '../types';

const { t } = useI18n();

interface Props {
  /** Product to populate the form with. */
  product?: Partial<ProductData>;
  /** Fired when the user submits the form. */
  onSubmit: (product: Partial<ProductData>) => void;
  /** Fired when the user clicks the cancel button. */
  onCancel?: () => void;
  /** Disables all inputs and shows "Saving..." when true. */
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

<div class="smrt-product-form__root" data-smrt-component="ProductForm">
  <Form onsubmit={handleSubmit} class="smrt-product-form__form">
    <div class="smrt-product-form__field" data-smrt-part="field">
      <label for="name">{t(M['products.product_form.name_label'])}</label>
      <Input
        id="name"
        type="text"
        bind:value={formData.name}
        disabled={loading}
        class={errors.name ? 'smrt-product-form__error' : ''}
        placeholder={t(M['products.product_form.name_placeholder'])}
      />
      {#if errors.name}
        <span class="smrt-product-form__error-message" data-smrt-part="error">{errors.name}</span>
      {/if}
    </div>

    <div class="smrt-product-form__field" data-smrt-part="field">
      <label for="description">Description</label>
      <Textarea
        id="description"
        bind:value={formData.description}
        disabled={loading}
        placeholder={t(M['products.product_form.description_placeholder'])}
        rows={3}
      ></Textarea>
    </div>

    <div class="smrt-product-form__row" data-smrt-part="row">
      <div class="smrt-product-form__field" data-smrt-part="field">
        <label for="price">Price *</label>
        <Input
          id="price"
          type="number"
          step="0.01"
          min="0"
          bind:value={formData.price}
          disabled={loading}
          class={errors.price ? 'smrt-product-form__error' : ''}
          placeholder="0.00"
        />
        {#if errors.price}
          <span class="smrt-product-form__error-message" data-smrt-part="error">{errors.price}</span>
        {/if}
      </div>

      <div class="smrt-product-form__field" data-smrt-part="field">
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

    <div class="smrt-product-form__field" data-smrt-part="field">
      <label for="tags">Tags</label>
      <Input
        id="tags"
        type="text"
        bind:value={formData.tags}
        disabled={loading}
        placeholder={t(M['products.product_form.tags_placeholder'])}
      />
      <small class="smrt-product-form__hint" data-smrt-part="description">{t(M['products.product_form.tags_hint'])}</small>
    </div>

    <div class="smrt-product-form__field" data-smrt-part="field">
      <label class="smrt-product-form__checkbox-label" data-smrt-part="label">
        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
        <input
          type="checkbox"
          bind:checked={formData.inStock}
          disabled={loading}
          class="smrt-product-form__checkbox" data-smrt-part="input"
        />
        {t(M['products.product_form.in_stock_label'])}
      </label>
    </div>

    <div class="smrt-product-form__actions" data-smrt-part="actions">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-product-form__root :global([data-smrt-component="Form"]) {
    max-width: 500px;
    padding: 1.5rem;
  }
  .smrt-product-form__field {
    margin-bottom: 1rem;
  }
  .smrt-product-form__row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  label {
    display: block;
    margin-bottom: 0.25rem;
  }
  .smrt-product-form__checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }
  .smrt-product-form__checkbox {
    width: auto;
  }
  .smrt-product-form__hint {
    margin-top: 0.25rem;
  }
  .smrt-product-form__error-message {
    margin-top: 0.25rem;
    display: block;
  }
  .smrt-product-form__actions {
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
    padding-top: 1rem;
  }
}

@layer smrt.theme {
  .smrt-product-form__root :global([data-smrt-component="Form"]) {
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-md);
    border: var(--smrt-hairline);
  }
  label {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  /* Error border on the migrated <Input>. The primitive forwards `class` onto
  its root element, so the scoped rule can't reach it without :global (#1589). */
  .smrt-product-form__root :global([data-smrt-component="Input"].smrt-product-form__error) {
    border-color: var(--smrt-color-error);
  }
  .smrt-product-form__hint {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }
  .smrt-product-form__error-message {
    color: var(--smrt-color-error);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  .smrt-product-form__actions {
    border-top: var(--smrt-hairline);
  }
}

</style>