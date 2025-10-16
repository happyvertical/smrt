<script lang="ts">
/**
 * Demo page showing SMRT "Define Once, Consume Everywhere" vision
 * Progressive customization: Auto-generated → Custom components
 */

import AutoForm from '../../lib/components/auto-generated/AutoForm.svelte';
import ProductCard from '../../lib/components/ProductCard.svelte';
import ProductForm from '../../lib/components/ProductForm.svelte';
import type { ProductData } from '../../lib/types';

const currentTab = $state<'auto' | 'custom' | 'comparison'>('auto');

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

let autoFormData = $state({ ...sampleProduct });
let customFormData = $state({ ...sampleProduct });

function handleAutoSubmit(data: ProductData) {
  console.log('Auto form submitted:', data);
  autoFormData = { ...data };
}

function handleCustomSubmit(data: ProductData) {
  console.log('Custom form submitted:', data);
  customFormData = { ...data };
}
</script>

<div class="demo-page">
  <header class="demo-header">
    <h1>SMRT Framework Demo</h1>
    <p class="demo-subtitle">
      Define Once, Consume Everywhere - Progressive Customization
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
      Custom Components
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
        <h2>Auto-Generated UI from SMRT Object</h2>
        <p class="section-description">
          This form is automatically generated from the Product class definition.
          The field types, labels, and validation rules are inferred from the TypeScript schema.
        </p>

        <div class="demo-grid">
          <div class="demo-column">
            <h3>Generated Form</h3>
            <AutoForm
              data={autoFormData}
              title="Auto-Generated Product Form"
              onSubmit={handleAutoSubmit}
              onChange={(data) => autoFormData = { ...data }}
            />
          </div>

          <div class="demo-column">
            <h3>Generated Display</h3>
            <ProductCard
              product={autoFormData}
              onEdit={() => {}}
            />
          </div>
        </div>
      </section>

    {:else if currentTab === 'custom'}
      <section class="demo-section">
        <h2>Custom Components with SMRT Integration</h2>
        <p class="section-description">
          These are hand-crafted components that still leverage the SMRT data structure
          but provide custom UI/UX for specific business requirements.
        </p>

        <div class="demo-grid">
          <div class="demo-column">
            <h3>Custom Form</h3>
            <ProductForm
              product={customFormData}
              onSave={handleCustomSubmit}
            />
          </div>

          <div class="demo-column">
            <h3>Custom Display</h3>
            <ProductCard
              product={customFormData}
              onEdit={() => {}}
            />
          </div>
        </div>
      </section>

    {:else if currentTab === 'comparison'}
      <section class="demo-section">
        <h2>Progressive Customization</h2>
        <p class="section-description">
          Start with auto-generated components, then progressively customize as needed.
          Both approaches use the same underlying SMRT Product model.
        </p>

        <div class="comparison-grid">
          <div class="comparison-column">
            <h3>🤖 Auto-Generated</h3>
            <div class="feature-list">
              <div class="feature">✅ Zero configuration</div>
              <div class="feature">✅ Instant UI from schema</div>
              <div class="feature">✅ Type-safe by default</div>
              <div class="feature">⚡ Perfect for prototyping</div>
            </div>
            <AutoForm
              data={autoFormData}
              title="Auto Form"
              readonly={true}
            />
          </div>

          <div class="comparison-column">
            <h3>🎨 Custom Components</h3>
            <div class="feature-list">
              <div class="feature">✅ Tailored UX</div>
              <div class="feature">✅ Business-specific workflows</div>
              <div class="feature">✅ Advanced interactions</div>
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
      <h4>SMRT Framework Benefits</h4>
      <ul>
        <li><strong>Define Once:</strong> Product class with @smrt decorator</li>
        <li><strong>Auto-Generate:</strong> REST APIs, MCP tools, TypeScript clients, default UI</li>
        <li><strong>Progressive Enhancement:</strong> Start with defaults, customize as needed</li>
        <li><strong>Type Safety:</strong> End-to-end TypeScript integration</li>
        <li><strong>Multiple Consumption:</strong> Library, federation, standalone</li>
      </ul>
    </div>
  </footer>
</div>

<style>
  .demo-page {
    min-height: 100vh;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #1f2937;
  }

  .demo-header {
    text-align: center;
    padding: 2rem 1rem;
    background: rgba(255, 255, 255, 0.95);
    margin-bottom: 2rem;
  }

  .demo-header h1 {
    font-size: 2.5rem;
    font-weight: 700;
    color: #1f2937;
    margin: 0 0 0.5rem 0;
  }

  .demo-subtitle {
    font-size: 1.125rem;
    color: #6b7280;
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
    background: rgba(255, 255, 255, 0.9);
    border: 2px solid transparent;
    border-radius: 0.5rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .nav-btn:hover {
    background: white;
    transform: translateY(-2px);
  }

  .nav-btn.active {
    background: white;
    border-color: #3b82f6;
    color: #3b82f6;
  }

  .demo-content {
    padding: 0 1rem 2rem;
  }

  .demo-section {
    max-width: 1200px;
    margin: 0 auto;
    background: rgba(255, 255, 255, 0.95);
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
  }

  .section-description {
    font-size: 1rem;
    color: #6b7280;
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
    color: #374151;
  }

  .comparison-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }

  .comparison-column {
    padding: 1.5rem;
    background: #f9fafb;
    border-radius: 0.5rem;
    border: 1px solid #e5e7eb;
  }

  .comparison-column h3 {
    text-align: center;
    margin-bottom: 1rem;
    font-size: 1.25rem;
  }

  .feature-list {
    margin-bottom: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .feature {
    font-size: 0.875rem;
    color: #374151;
  }

  .demo-footer {
    background: rgba(255, 255, 255, 0.95);
    padding: 2rem;
    margin-top: 2rem;
  }

  .framework-info {
    max-width: 800px;
    margin: 0 auto;
    text-align: center;
  }

  .framework-info h4 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 1rem;
    color: #1f2937;
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
    background: #f3f4f6;
    border-radius: 0.375rem;
    font-size: 0.875rem;
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
      font-size: 2rem;
    }
  }
</style>