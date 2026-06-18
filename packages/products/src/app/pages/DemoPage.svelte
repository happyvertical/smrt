<script lang="ts">
/**
 * Demo page showing SMRT "Define Once, Consume Everywhere" vision
 * Progressive customization: Auto-generated → Custom components
 */

import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { M } from '../../lib/i18n.js';
import type { ProductData } from '../../lib/types';

const { t } = useI18n();

const _currentTab = $state<'auto' | 'custom' | 'comparison'>('auto');

// Sample data for demonstration
const sampleProduct: ProductData = $state({
  name: 'Sample Widget',
  description: 'A demonstration product for the SMRT framework',
  category: 'Electronics',
  manufacturer: 'SMRT Industries',
  model: 'SW-2024',
  specifications: {
    weight: '2.5kg',
    dimensions: '10x8x3cm',
    warranty: '2 years',
  },
  tags: ['demo', 'widget', 'smrt'],
});

let _autoFormData = $state({ ...sampleProduct });
let _customFormData = $state({ ...sampleProduct });

function _handleAutoSubmit(data: ProductData) {
  _autoFormData = { ...data };
}

function _handleCustomSubmit(data: ProductData) {
  _customFormData = { ...data };
}
</script>

<div class="demo-page">
  <header class="demo-header">
    <h1>{t(M['products.demo_page.title'])}</h1>
    <p class="demo-subtitle">
      {t(M['products.demo_page.subtitle'])}
    </p>
  </header>

  <nav class="demo-nav">
    <button
      class="nav-btn"
      class:active={currentTab === 'auto'}
      onclick={() => currentTab = 'auto'}
    >
      Auto-Generated
    </button>
    <button
      class="nav-btn"
      class:active={currentTab === 'custom'}
      onclick={() => currentTab = 'custom'}
    >
      {t(M['products.demo_page.custom_components_tab'])}
    </button>
    <button
      class="nav-btn"
      class:active={currentTab === 'comparison'}
      onclick={() => currentTab = 'comparison'}
    >
      Side-by-Side
    </button>
  </nav>

  <main class="demo-content">
    {#if currentTab === 'auto'}
      <section class="demo-section">
        <h2>{t(M['products.demo_page.auto_generated_heading'])}</h2>
        <p class="section-description">
          {t(M['products.demo_page.auto_generated_description'])}
        </p>

        <div class="demo-grid">
          <div class="demo-column">
            <h3>{t(M['products.demo_page.generated_form_heading'])}</h3>
            <AutoForm
              data={autoFormData}
              title={t(M['products.demo_page.auto_form_title'])}
              onSubmit={handleAutoSubmit}
              onChange={(data) => autoFormData = { ...data }}
            />
          </div>

          <div class="demo-column">
            <h3>{t(M['products.demo_page.generated_display_heading'])}</h3>
            <ProductCard
              product={autoFormData}
              onEdit={() => {}}
            />
          </div>
        </div>
      </section>

    {:else if currentTab === 'custom'}
      <section class="demo-section">
        <h2>{t(M['products.demo_page.custom_components_heading'])}</h2>
        <p class="section-description">
          {t(M['products.demo_page.custom_components_description'])}
        </p>

        <div class="demo-grid">
          <div class="demo-column">
            <h3>{t(M['products.demo_page.custom_form_heading'])}</h3>
            <ProductForm
              product={customFormData}
              onSave={handleCustomSubmit}
            />
          </div>

          <div class="demo-column">
            <h3>{t(M['products.demo_page.custom_display_heading'])}</h3>
            <ProductCard
              product={customFormData}
              onEdit={() => {}}
            />
          </div>
        </div>
      </section>

    {:else if currentTab === 'comparison'}
      <section class="demo-section">
        <h2>{t(M['products.demo_page.progressive_heading'])}</h2>
        <p class="section-description">
          {t(M['products.demo_page.progressive_description'])}
        </p>

        <div class="comparison-grid">
          <div class="comparison-column">
            <h3>🤖 Auto-Generated</h3>
            <div class="feature-list">
              <div class="feature">{t(M['products.demo_page.feature_zero_config'])}</div>
              <div class="feature">{t(M['products.demo_page.feature_instant_ui'])}</div>
              <div class="feature">{t(M['products.demo_page.feature_type_safe'])}</div>
              <div class="feature">{t(M['products.demo_page.feature_prototyping'])}</div>
            </div>
            <AutoForm
              data={autoFormData}
              title={t(M['products.demo_page.simple_auto_form_title'])}
              readonly={true}
            />
          </div>

          <div class="comparison-column">
            <h3>{t(M['products.demo_page.custom_components_label'])}</h3>
            <div class="feature-list">
              <div class="feature">{t(M['products.demo_page.feature_tailored_ux'])}</div>
              <div class="feature">{t(M['products.demo_page.feature_business_workflows'])}</div>
              <div class="feature">{t(M['products.demo_page.feature_advanced_interactions'])}</div>
              <div class="feature">⚡ Production-ready</div>
            </div>
            <ProductForm
              product={customFormData}
              readonly={true}
            />
          </div>
        </div>
      </section>
    {/if}
  </main>

  <footer class="demo-footer">
    <div class="framework-info">
      <h4>{t(M['products.demo_page.benefits_heading'])}</h4>
      <ul>
        <li><strong>{t(M['products.demo_page.benefit_define_once_label'])}</strong> {t(M['products.demo_page.benefit_define_once_text'])}</li>
        <li><strong>{t(M['products.demo_page.benefit_auto_generate_label'])}</strong> {t(M['products.demo_page.benefit_auto_generate_text'])}</li>
        <li><strong>{t(M['products.demo_page.benefit_progressive_label'])}</strong> {t(M['products.demo_page.benefit_progressive_text'])}</li>
        <li><strong>{t(M['products.demo_page.benefit_type_safety_label'])}</strong> {t(M['products.demo_page.benefit_type_safety_text'])}</li>
        <li><strong>{t(M['products.demo_page.benefit_multiple_consumption_label'])}</strong> {t(M['products.demo_page.benefit_multiple_consumption_text'])}</li>
      </ul>
    </div>
  </footer>
</div>

<style>
  .demo-page {
    min-height: 100vh;
    background: linear-gradient(
      135deg,
      var(--smrt-color-primary, #667eea) 0%,
      var(--smrt-color-primary-container, #764ba2) 100%
    );
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .demo-header {
    text-align: center;
    padding: 2rem 1rem;
    background: color-mix(in srgb, var(--smrt-color-surface, #fff) 95%, transparent);
    margin-bottom: 2rem;
  }

  .demo-header h1 {
    font-size: var(--smrt-typography-display-medium-size, 2.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface, #1f2937);
    margin: 0 0 0.5rem 0;
  }

  .demo-subtitle {
    font-size: var(--smrt-typography-body-large-size, 1.125rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin: 0;
  }

  .demo-nav {
    display: flex;
    justify-content: center;
    gap: 1rem;
    margin-bottom: 2rem;
    padding: 0 1rem;
  }

  .nav-btn {
    padding: 0.75rem 1.5rem;
    background: color-mix(in srgb, var(--smrt-color-surface, #fff) 90%, transparent);
    border: 2px solid transparent;
    border-radius: 0.5rem;
    font-weight: var(--smrt-typography-weight-medium, 500);
    cursor: pointer;
    transition: all 0.2s;
  }

  .nav-btn:hover {
    background: white;
    transform: translateY(-2px);
  }

  .nav-btn.active {
    background: white;
    border-color: var(--smrt-color-primary, #3b82f6);
    color: var(--smrt-color-primary, #3b82f6);
  }

  .demo-content {
    padding: 0 1rem 2rem;
  }

  .demo-section {
    max-width: 1200px;
    margin: 0 auto;
    background: color-mix(in srgb, var(--smrt-color-surface, #fff) 95%, transparent);
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
  }

  .section-description {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin-bottom: 2rem;
    text-align: center;
  }

  .demo-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }

  .demo-column h3 {
    text-align: center;
    margin-bottom: 1rem;
    color: var(--smrt-color-on-surface, #374151);
  }

  .comparison-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }

  .comparison-column {
    padding: 1.5rem;
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-radius: 0.5rem;
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
  }

  .comparison-column h3 {
    text-align: center;
    margin-bottom: 1rem;
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
  }

  .feature-list {
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .feature {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface, #374151);
  }

  .demo-footer {
    background: color-mix(in srgb, var(--smrt-color-surface, #fff) 95%, transparent);
    padding: 2rem;
    margin-top: 2rem;
  }

  .framework-info {
    max-width: 800px;
    margin: 0 auto;
    text-align: center;
  }

  .framework-info h4 {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    margin-bottom: 1rem;
    color: var(--smrt-color-on-surface, #1f2937);
  }

  .framework-info ul {
    list-style: none;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 0.75rem;
  }

  .framework-info li {
    padding: 0.75rem;
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-radius: 0.375rem;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  @media (max-width: 768px) {
    .demo-grid,
    .comparison-grid {
      grid-template-columns: 1fr;
    }

    .demo-nav {
      flex-direction: column;
      align-items: center;
    }

    .demo-header h1 {
      font-size: var(--smrt-typography-headline-large-size, 2rem);
    }
  }
</style>