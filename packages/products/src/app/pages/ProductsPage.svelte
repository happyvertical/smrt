<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import ProductCatalog from '../../lib/features/ProductCatalog.svelte';
import { M } from '../../lib/i18n.js';
import AppLayout from '../layouts/AppLayout.svelte';

const { t } = useI18n();
</script>

<AppLayout>
  {#snippet children()}
    <div class="products-page">
      <div class="page-header">
        <h1>Products</h1>
        <p class="page-description">
          {t(M['products.products_page.description'])}
        </p>
      </div>
      
      <div class="page-content">
        <ProductCatalog showCreateForm={true} />
      </div>
      
      <div class="integration-info">
        <div class="info-cards">
          <div class="info-card">
            <h3>🔄 Auto-Generated</h3>
            <p>{t(M['products.products_page.auto_generated_text'])}</p>
          </div>
          
          <div class="info-card">
            <h3>{t(M['products.products_page.ai_ready_heading'])}</h3>
            <p>{t(M['products.products_page.ai_ready_text'])}</p>
          </div>
          
          <div class="info-card">
            <h3>📦 Federatable</h3>
            <p>{t(M['products.products_page.federatable_text'])}</p>
          </div>
          
          <div class="info-card">
            <h3>📚 Library</h3>
            <p>{t(M['products.products_page.library_text'])}</p>
          </div>
        </div>
      </div>
    </div>
  {/snippet}
</AppLayout>

<style>
  .products-page {
    max-width: 1200px;
    margin: 0 auto;
  }
  
  .page-header {
    text-align: center;
    margin-bottom: 2rem;
  }
  
  .page-header h1 {
    margin: 0 0 0.5rem 0;
    font-size: var(--smrt-typography-display-small-size, 2.25rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .page-description {
    margin: 0;
    font-size: var(--smrt-typography-body-large-size, 1.125rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    max-width: 600px;
    margin: 0 auto;
    line-height: var(--smrt-typography-body-large-line-height, 1.6);
  }

  .page-content {
    margin-bottom: 3rem;
  }

  .integration-info {
    margin-top: 3rem;
    padding-top: 2rem;
    border-top: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
  }
  
  .info-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
  }
  
  .info-card {
    background: var(--smrt-color-surface, #fff);
    padding: 1.5rem;
    border-radius: var(--smrt-radius-md, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    text-align: center;
  }

  .info-card h3 {
    margin: 0 0 0.5rem 0;
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .info-card p {
    margin: 0;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    line-height: var(--smrt-typography-body-medium-line-height, 1.5);
  }
</style>