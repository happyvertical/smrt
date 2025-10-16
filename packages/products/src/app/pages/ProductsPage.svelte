<script lang="ts">

</script>

<AppLayout>
  {#snippet children()}
    <div class="products-page">
      <div class="page-header">
        <h1>Products</h1>
        <p class="page-description">
          Manage your product catalog with auto-generated CRUD operations, 
          real-time updates, and AI-powered tools via MCP.
        </p>
      </div>
      
      <div class="page-content">
        <ProductCatalog showCreateForm={true} />
      </div>
      
      <div class="integration-info">
        <div class="info-cards">
          <div class="info-card">
            <h3>🔄 Auto-Generated</h3>
            <p>REST API endpoints automatically created from @smrt() decorated Product class</p>
          </div>
          
          <div class="info-card">
            <h3>🤖 AI Ready</h3>
            <p>MCP tools available for Claude and other AI models to interact with products</p>
          </div>
          
          <div class="info-card">
            <h3>📦 Federatable</h3>
            <p>Components can be consumed by other applications via module federation</p>
          </div>
          
          <div class="info-card">
            <h3>📚 Library</h3>
            <p>Install as NPM package: npm install @have/smrt-template</p>
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
    font-size: 2.25rem;
    font-weight: 800;
    color: #1f2937;
  }
  
  .page-description {
    margin: 0;
    font-size: 1.125rem;
    color: #6b7280;
    max-width: 600px;
    margin: 0 auto;
    line-height: 1.6;
  }
  
  .page-content {
    margin-bottom: 3rem;
  }
  
  .integration-info {
    margin-top: 3rem;
    padding-top: 2rem;
    border-top: 1px solid #e2e8f0;
  }
  
  .info-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
  }
  
  .info-card {
    background: white;
    padding: 1.5rem;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
    text-align: center;
  }
  
  .info-card h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: #1f2937;
  }
  
  .info-card p {
    margin: 0;
    font-size: 0.875rem;
    color: #6b7280;
    line-height: 1.5;
  }
</style>