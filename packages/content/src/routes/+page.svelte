<script lang="ts">
import { onMount } from 'svelte';
import { createClient } from '../mock-smrt-client';
import ContentEditor from '../svelte/components/ContentEditor.svelte';
import ContentList from '../svelte/components/ContentList.svelte';
import GovernedContentEditor from '../svelte/components/GovernedContentEditor.svelte';

const client = createClient('/api/v1');

let contents = $state<any[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);

// UI State
let showAddForm = $state(false);
let editingContent = $state<any>(null);
let editorMode = $state<'generic' | 'governed'>('generic');

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
    const payload = formData;

    if (editingContent?.id) {
      // Update existing
      const response = await client.contents.update(editingContent.id, payload);
      const index = contents.findIndex((c) => c.id === editingContent.id);
      if (index >= 0) {
        contents[index] = response.data;
      } else {
        contents = [...contents, response.data];
      }
    } else {
      // Create new (including governed drafts without an id)
      const response = await client.contents.create(payload);
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
    const governance = await client.contents.resolveGovernance({
      type: response.data.type,
      variant: response.data.variant,
    });
    editorMode = governance.data.isGoverned ? 'governed' : 'generic';
  } catch (err: any) {
    // Fall back to the list item if fetch fails
    console.error('Failed to fetch full content record:', err);
    editingContent = content;
    editorMode = 'generic';
  }
  showAddForm = false;
}

function handleAddContent() {
  editingContent = null;
  showAddForm = true;
  editorMode = 'generic';
}

function handleAddGovernedContent() {
  editingContent = {
    type: 'article',
    status: 'draft',
    state: 'active',
    source: 'manual',
  };
  showAddForm = true;
  editorMode = 'governed';
}

function closeForms() {
  editingContent = null;
  showAddForm = false;
  editorMode = 'generic';
}

function getPublishedHref(content: any) {
  if (content?.status !== 'published' || !content?.slug) {
    return null;
  }

  return `/articles/${content.slug}`;
}
</script>

<div class="page">
  <div class="page-header">
    <h1>📝 Contents</h1>
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
          {#if editorMode === 'governed'}
            <GovernedContentEditor
              content={editingContent}
              contentId={editingContent?.id || 'new'}
              onSave={handleSaveContent}
              onCancel={closeForms}
            />
          {:else}
            <ContentEditor 
              content={editingContent}
              contentId={editingContent?.id || 'new'}
              onSave={handleSaveContent}
              onCancel={closeForms}
            />
          {/if}
        </div>
      {:else}
        <ContentList 
          {contents}
          getViewHref={getPublishedHref}
          onEdit={handleEditContent}
          onDelete={handleDeleteContent}
          onAdd={handleAddContent}
        >
          <!-- Example of injecting custom controls via Svelte Snippet -->
          {#snippet controls()}
            <div class="custom-control">
              <button type="button" class="secondary-action" onclick={handleAddGovernedContent}>
                Add governed article
              </button>
              <span class="badge state-active">Published QA ready</span>
            </div>
          {/snippet}
        </ContentList>
      {/if}
    {/if}
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .page-header {
    text-align: center;
    padding: 1rem 0;
  }

  .page-header h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
    font-weight: 800;
    color: var(--smrt-color-on-background, #1a1c1e);
  }

  .page-header p {
    margin: 0 auto;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 1.05rem;
    max-width: 600px;
  }

  .content-section {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: 1rem;
    padding: 2rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    position: relative;
    min-height: 400px;
  }

  .stats-grid {
    margin-bottom: 2rem;
  }

  .stat-card {
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    border-radius: 0.75rem;
    padding: 1.5rem;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .stat-card h2 {
    margin: 0 0 1rem 0;
    color: var(--smrt-color-on-surface, #1a1c1e);
    font-size: 1.5rem;
  }

  .stats {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
  }

  .stat {
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 0.875rem;
  }

  .stat strong {
    color: var(--smrt-color-on-surface, #1a1c1e);
    font-size: 1.5rem;
    display: block;
  }

  .custom-control {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .secondary-action {
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    background: var(--smrt-color-surface, #fff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    border-radius: 999px;
    padding: 0.55rem 0.95rem;
    font-weight: 600;
    cursor: pointer;
  }

  .secondary-action:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }
  
  .badge {
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
  }
  .state-active { background: var(--smrt-color-success-container, #dcfce7); color: var(--smrt-color-on-success-container, #166534); border: 1px solid var(--smrt-color-outline-variant); }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 4rem;
    color: var(--smrt-color-on-surface-variant, #74777f);
    font-size: 1.25rem;
  }

  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-top-color: var(--smrt-color-primary, #005ac1);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  .error-state {
    background: var(--smrt-color-error-container, #ffdad6);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    color: var(--smrt-color-on-error-container, #410002);
    padding: 2rem;
    border-radius: 0.5rem;
    text-align: center;
  }
  
  .error-state button {
    margin-top: 1rem;
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline, #74777f);
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    cursor: pointer;
    color: var(--smrt-color-error, #ba1a1a);
    font-weight: 500;
  }

  .editor-unified-container {
    width: 100%;
  }
</style>

