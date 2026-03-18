<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-svelte/themes';
import { onMount } from 'svelte';
import { createClient } from '../mock-smrt-client';
import ContentEditor from '../svelte/components/ContentEditor.svelte';
import ContentList from '../svelte/components/ContentList.svelte';

const client = createClient('/api/v1');

let contents = $state<any[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

// UI State
let showAddForm = $state(false);
let editingContent = $state<any>(null);

const stats = $derived({
  total: contents.length,
  published: contents.filter((c) => c.status === 'published').length,
  highlighted: contents.filter((c) => c.state === 'highlighted').length,
});

onMount(async () => {
  await loadContents();
});

async function loadContents() {
  try {
    loading = true;
    const response = await client.contents.list();
    contents = response.data;
    error = null;
  } catch (err: any) {
    error = err.message;
  } finally {
    loading = false;
  }
}

async function handleSaveContent(formData: any) {
  try {
    if (editingContent) {
      // Update existing
      const response = await client.contents.update(
        editingContent.id,
        formData,
      );
      const index = contents.findIndex((c) => c.id === editingContent.id);
      contents[index] = response.data;
    } else {
      // Create new
      const response = await client.contents.create(formData);
      contents = [...contents, response.data];
    }
    closeForms();
  } catch (err: any) {
    error = err.message;
  }
}

async function handleDeleteContent(content: any) {
  try {
    await client.contents.delete(content.id);
    contents = contents.filter((c) => c.id !== content.id);
  } catch (err: any) {
    error = err.message;
  }
}

async function handleEditContent(content: any) {
  try {
    // Fetch the full record with hydrated assets/referenceIds
    const response = await client.contents.get(content.id);
    editingContent = response.data;
  } catch (err: any) {
    // Fall back to the list item if fetch fails
    console.error('Failed to fetch full content record:', err);
    editingContent = content;
  }
  showAddForm = false;
}

function handleAddContent() {
  editingContent = null;
  showAddForm = true;
}

function closeForms() {
  editingContent = null;
  showAddForm = false;
}
</script>

<ThemeProvider colorScheme="system" persist={true}>
<div class="app">
  <header class="header">
    <div class="container">
      <h1>📝 Content Service</h1>
      <div class="status">Online</div>
    </div>
  </header>

  <main class="main">
    <div class="container">
      <div class="hero">
        <h1>Contents</h1>
        <p>Manage your content library with auto-generated CRUD operations, document processing, and AI-powered tools via MCP.</p>
      </div>

      <div class="content-section">
        <div class="stats-grid">
          <div class="stat-card">
            <h2>Content Catalog</h2>
            <div class="stats">
              <div class="stat">
                <strong>{stats.total}</strong>
                contents
              </div>
              <div class="stat">
                <strong>{stats.published}</strong>
                published
              </div>
              <div class="stat">
                Total highlighted: <strong>{stats.highlighted}</strong>
              </div>
            </div>
          </div>
        </div>

        {#if loading}
          <div class="loading-state">
            <span class="spinner"></span> Loading contents...
          </div>
        {:else if error}
          <div class="error-state">
            <p><strong>Error:</strong> {error}</p>
            <button onclick={loadContents}>Try Again</button>
          </div>
        {:else}
        
          {#if showAddForm || editingContent}
            <div class="editor-unified-container">
              <ContentEditor 
                content={editingContent}
                contentId={editingContent?.id || 'new'}
                onSave={handleSaveContent}
                onCancel={closeForms}
              />
            </div>
          {:else}
            <ContentList 
              {contents}
              onEdit={handleEditContent}
              onDelete={handleDeleteContent}
              onAdd={handleAddContent}
            >
              <!-- Example of injecting custom controls via Svelte Snippet -->
              {#snippet controls()}
                <div class="custom-control">
                  <span class="badge state-active">App Injected Control</span>
                </div>
              {/snippet}
            </ContentList>
          {/if}
        {/if}
      </div>

      <div class="features-grid">
        <div class="feature">
          <h3>🔄 Auto-Generated</h3>
          <p>REST API endpoints automatically created from @smrt() decorated Content class</p>
        </div>
        <div class="feature">
          <h3>🤖 AI Ready</h3>
          <p>MCP tools available for Claude and other AI models to interact with content</p>
        </div>
        <div class="feature">
          <h3>📄 Document Processing</h3>
          <p>Automatic content extraction from PDFs, web pages, and other document types</p>
        </div>
        <div class="feature">
          <h3>📚 Library</h3>
          <p>Install as NPM package: npm install @have/content</p>
        </div>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="container">
      <p>© 2024 SMRT Content Service - Auto-generated with ❤️</p>
    </div>
  </footer>
</div>
</ThemeProvider>

<style>
  :global(body) {
    margin: 0;
    font-family: var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    background: var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    min-height: 100vh;
  }

  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 20px;
  }

  .header {
    background: var(--smrt-color-surface);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding: 1rem 0;
  }

  .header .container {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header h1 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--smrt-color-on-surface);
  }

  .status {
    background: var(--smrt-color-success, #10b981);
    color: var(--smrt-color-on-success, white);
    padding: 0.25rem 0.75rem;
    border-radius: 1rem;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .main {
    flex: 1;
    padding: 2rem 0;
  }

  .hero {
    text-align: center;
    margin-bottom: 3rem;
    color: var(--smrt-color-on-background);
  }

  .hero h1 {
    font-size: 3rem;
    margin: 0 0 1rem 0;
    font-weight: 800;
  }

  .hero p {
    font-size: 1.25rem;
    opacity: 0.8;
    max-width: 600px;
    margin: 0 auto;
  }

  .content-section {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
    box-shadow: var(--smrt-elevation-2, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
    position: relative;
    min-height: 500px;
  }

  .stats-grid {
    margin-bottom: 2rem;
  }

  .stat-card {
    background: var(--smrt-color-surface-container-low);
    border-radius: 0.75rem;
    padding: 1.5rem;
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .stat-card h2 {
    margin: 0 0 1rem 0;
    color: var(--smrt-color-on-surface);
    font-size: 1.5rem;
  }

  .stats {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
  }

  .stat {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
  }

  .stat strong {
    color: var(--smrt-color-on-surface);
    font-size: 1.5rem;
    display: block;
  }

  .custom-control {
    display: flex;
    align-items: center;
  }
  
  .badge {
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .state-active { background: var(--smrt-color-success-container, #dcfce7); color: var(--smrt-color-on-success-container, #166534); border: 1px solid var(--smrt-color-outline-variant); }

  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
    margin-top: 3rem;
  }

  .feature {
    background: var(--smrt-color-surface-variant);
    padding: 1.5rem;
    border-radius: 1rem;
    color: var(--smrt-color-on-surface-variant);
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .feature h3 {
    margin: 0 0 0.5rem 0;
    color: var(--smrt-color-on-surface);
  }

  .feature p {
    margin: 0;
    opacity: 0.9;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .footer {
    text-align: center;
    padding: 2rem 0;
    color: var(--smrt-color-on-surface-variant);
    opacity: 0.8;
  }
  
  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 4rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: 1.25rem;
  }
  
  .error-state {
    background: var(--smrt-color-error-container);
    border: 1px solid var(--smrt-color-outline-variant);
    color: var(--smrt-color-on-error-container);
    padding: 2rem;
    border-radius: 0.5rem;
    text-align: center;
  }
  
  .error-state button {
    margin-top: 1rem;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline);
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    cursor: pointer;
    color: var(--smrt-color-error);
    font-weight: 500;
  }
  
  .error-state button:hover {
    background: var(--smrt-color-surface-variant);
  }

  .editor-unified-container {
    width: 100%;
  }
</style>
