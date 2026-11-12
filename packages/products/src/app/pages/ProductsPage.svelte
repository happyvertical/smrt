<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import ProductCatalog from '../../lib/features/ProductCatalog.svelte';
import { M } from '../../lib/i18n.js';
import AppLayout from '../layouts/AppLayout.svelte';

const { t } = useI18n();
</script>

<AppLayout>
  {#snippet children()}
    <div class="smrt-products-page__root" data-smrt-part="body">
      <div class="smrt-products-page__header" data-smrt-part="header">
        <h1>Products</h1>
        <p class="smrt-products-page__description" data-smrt-part="meta">
          {t(M['products.products_page.description'])}
        </p>
      </div>
      
      <div class="smrt-products-page__content" data-smrt-part="body">
        <ProductCatalog showCreateForm={true} />
      </div>
      
      <div class="smrt-products-page__integration" data-smrt-part="body">
        <div class="smrt-products-page__cards" data-smrt-part="list">
          <div class="smrt-products-page__card" data-smrt-part="item">
            <h3>🔄 Auto-Generated</h3>
            <p>{t(M['products.products_page.auto_generated_text'])}</p>
          </div>
          
          <div class="smrt-products-page__card" data-smrt-part="item">
            <h3>{t(M['products.products_page.ai_ready_heading'])}</h3>
            <p>{t(M['products.products_page.ai_ready_text'])}</p>
          </div>
          
          <div class="smrt-products-page__card" data-smrt-part="item">
            <h3>📦 Federatable</h3>
            <p>{t(M['products.products_page.federatable_text'])}</p>
          </div>
          
          <div class="smrt-products-page__card" data-smrt-part="item">
            <h3>📚 Library</h3>
            <p>{t(M['products.products_page.library_text'])}</p>
          </div>
        </div>
      </div>
    </div>
  {/snippet}
</AppLayout>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-products-page__root {
    max-width: 1200px;
    margin: 0 auto;
  }
  .smrt-products-page__header {
    margin-bottom: 2rem;
  }
  .smrt-products-page__header h1 {
    margin: 0 0 0.5rem 0;
  }
  .smrt-products-page__description {
    margin: 0;
    max-width: 600px;
    margin: 0 auto;
  }
  .smrt-products-page__content {
    margin-bottom: 3rem;
  }
  .smrt-products-page__integration {
    margin-top: 3rem;
    padding-top: 2rem;
  }
  .smrt-products-page__cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
  }
  .smrt-products-page__card {
    padding: 1.5rem;
  }
  .smrt-products-page__card h3 {
    margin: 0 0 0.5rem 0;
  }
  .smrt-products-page__card p {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-products-page__header {
    text-align: center;
  }
  .smrt-products-page__header h1 {
    font-size: var(--smrt-typography-display-small-size, 2.25rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    color: var(--smrt-color-on-surface);
  }
  .smrt-products-page__description {
    font-size: var(--smrt-typography-body-large-size, 1.125rem);
    color: var(--smrt-color-on-surface-variant);
    line-height: var(--smrt-typography-body-large-line-height, 1.6);
  }
  .smrt-products-page__integration {
    border-top: var(--smrt-hairline);
  }
  .smrt-products-page__card {
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-md);
    border: var(--smrt-hairline);
    text-align: center;
  }
  .smrt-products-page__card h3 {
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-products-page__card p {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
    line-height: var(--smrt-typography-body-medium-line-height, 1.5);
  }
}

</style>