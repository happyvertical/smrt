<script>
import { onMount } from 'svelte';
import { createClient } from '../mock-smrt-client.ts';

const client = createClient('/api/v1');

let contents = $state([]);
let loading = $state(true);
let error = $state(null);
let showAddForm = $state(false);
let editingContent = $state(null);
const searchTerm = $state('');
const selectedType = $state('All Types');

let newContent = $state({
  title: '',
  description: '',
  body: '',
  author: '',
  type: 'article',
  status: 'draft',
  state: 'active',
  source: 'manual',
  url: '',
  fileKey: '',
});

const stats = $derived({
  total: contents.length,
  published: contents.filter((c) => c.status === 'published').length,
  highlighted: contents.filter((c) => c.state === 'highlighted').length,
});

const filteredContents = $derived(
  contents.filter((content) => {
    const matchesSearch =
      searchTerm === '' ||
      content.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      content.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      content.author?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesType =
      selectedType === 'All Types' ||
      (selectedType === 'Articles' && content.type === 'article') ||
      (selectedType === 'Documents' && content.type === 'document') ||
      (selectedType === 'Mirrors' && content.type === 'mirror');

    return matchesSearch && matchesType;
  }),
);

onMount(async () => {
  await loadContents();
});

async function loadContents() {
  try {
    loading = true;
    const response = await client.contents.list();
    contents = response.data;
    error = null;
  } catch (err) {
    error = err.message;
  } finally {
    loading = false;
  }
}

async function handleAddContent() {
  try {
    const response = await client.contents.create(newContent);
    contents = [...contents, response.data];

    // Reset form
    newContent = {
      title: '',
      description: '',
      body: '',
      author: '',
      type: 'article',
      status: 'draft',
      state: 'active',
      source: 'manual',
      url: '',
      fileKey: '',
    };
    showAddForm = false;
  } catch (err) {
    error = err.message;
  }
}

async function handleEditContent(content) {
  editingContent = { ...content };
}

async function handleUpdateContent() {
  try {
    const response = await client.contents.update(
      editingContent.id,
      editingContent,
    );
    const index = contents.findIndex((c) => c.id === editingContent.id);
    contents[index] = response.data;
    editingContent = null;
  } catch (err) {
    error = err.message;
  }
}

async function handleDeleteContent(content) {
  if (confirm(`Are you sure you want to delete "${content.title}"?`)) {
    try {
      await client.contents.delete(content.id);
      contents = contents.filter((c) => c.id !== content.id);
    } catch (err) {
      error = err.message;
    }
  }
}

function cancelEdit() {
  editingContent = null;
}

function cancelAdd() {
  showAddForm = false;
  newContent = {
    title: '',
    description: '',
    body: '',
    author: '',
    type: 'article',
    status: 'draft',
    state: 'active',
    source: 'manual',
    url: '',
    fileKey: '',
  };
}

function getTypeIcon(type) {
  switch (type) {
    case 'article':
      return '📄';
    case 'mirror':
      return '🌐';
    case 'document':
      return '📋';
    default:
      return '📝';
  }
}

function getStatusBadge(status) {
  switch (status) {
    case 'published':
      return 'published';
    case 'draft':
      return 'draft';
    case 'archived':
      return 'archived';
    default:
      return 'unknown';
  }
}

function getStateBadge(state) {
  switch (state) {
    case 'highlighted':
      return 'highlighted';
    case 'active':
      return 'active';
    case 'deprecated':
      return 'deprecated';
    default:
      return 'unknown';
  }
}
</script>

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

        <div class="content-controls">
          <div class="search-filters">
            <input type="text" placeholder="Search contents..." bind:value={searchTerm} />
            <select bind:value={selectedType}>
              <option>All Types</option>
              <option>Articles</option>
              <option>Documents</option>
              <option>Mirrors</option>
            </select>
          </div>
          <button class="add-button" onclick={() => showAddForm = true}>Add Content</button>
        </div>

        {#if loading}
          <p>Loading contents...</p>
        {:else if error}
          <p class="error">Error: {error}</p>
        {:else}
          <!-- Add Content Form -->
          {#if showAddForm}
            <div class="form-modal">
              <div class="form-container">
                <h3>Add New Content</h3>
                <form onsubmit={e => { e.preventDefault(); handleAddContent(); }}>
                  <div class="form-row">
                    <label>
                      Title:
                      <input type="text" bind:value={newContent.title} required />
                    </label>
                    <label>
                      Author:
                      <input type="text" bind:value={newContent.author} />
                    </label>
                  </div>

                  <label>
                    Description:
                    <input type="text" bind:value={newContent.description} />
                  </label>

                  <label>
                    Body:
                    <textarea bind:value={newContent.body} rows="4"></textarea>
                  </label>

                  <div class="form-row">
                    <label>
                      Type:
                      <select bind:value={newContent.type}>
                        <option value="article">Article</option>
                        <option value="document">Document</option>
                        <option value="mirror">Mirror</option>
                      </select>
                    </label>
                    <label>
                      Status:
                      <select bind:value={newContent.status}>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                        <option value="archived">Archived</option>
                      </select>
                    </label>
                    <label>
                      State:
                      <select bind:value={newContent.state}>
                        <option value="active">Active</option>
                        <option value="highlighted">Highlighted</option>
                        <option value="deprecated">Deprecated</option>
                      </select>
                    </label>
                  </div>

                  <div class="form-row">
                    <label>
                      URL:
                      <input type="url" bind:value={newContent.url} />
                    </label>
                    <label>
                      File Key:
                      <input type="text" bind:value={newContent.fileKey} />
                    </label>
                  </div>

                  <div class="form-actions">
                    <button type="submit" class="save-button">Add Content</button>
                    <button type="button" onclick={cancelAdd} class="cancel-button">Cancel</button>
                  </div>
                </form>
              </div>
            </div>
          {/if}

          <!-- Edit Content Form -->
          {#if editingContent}
            <div class="form-modal">
              <div class="form-container">
                <h3>Edit Content</h3>
                <form onsubmit={e => { e.preventDefault(); handleUpdateContent(); }}>
                  <div class="form-row">
                    <label>
                      Title:
                      <input type="text" bind:value={editingContent.title} required />
                    </label>
                    <label>
                      Author:
                      <input type="text" bind:value={editingContent.author} />
                    </label>
                  </div>

                  <label>
                    Description:
                    <input type="text" bind:value={editingContent.description} />
                  </label>

                  <label>
                    Body:
                    <textarea bind:value={editingContent.body} rows="4"></textarea>
                  </label>

                  <div class="form-row">
                    <label>
                      Type:
                      <select bind:value={editingContent.type}>
                        <option value="article">Article</option>
                        <option value="document">Document</option>
                        <option value="mirror">Mirror</option>
                      </select>
                    </label>
                    <label>
                      Status:
                      <select bind:value={editingContent.status}>
                        <option value="draft">Draft</option>
                        <option value="published">Published</option>
                        <option value="archived">Archived</option>
                      </select>
                    </label>
                    <label>
                      State:
                      <select bind:value={editingContent.state}>
                        <option value="active">Active</option>
                        <option value="highlighted">Highlighted</option>
                        <option value="deprecated">Deprecated</option>
                      </select>
                    </label>
                  </div>

                  <div class="form-row">
                    <label>
                      URL:
                      <input type="url" bind:value={editingContent.url} />
                    </label>
                    <label>
                      File Key:
                      <input type="text" bind:value={editingContent.fileKey} />
                    </label>
                  </div>

                  <div class="form-actions">
                    <button type="submit" class="save-button">Update Content</button>
                    <button type="button" onclick={cancelEdit} class="cancel-button">Cancel</button>
                  </div>
                </form>
              </div>
            </div>
          {/if}

          <div class="content-grid">
            {#each filteredContents as content (content.id)}
              <div class="content-card">
                <div class="content-header">
                  <h3>{getTypeIcon(content.type)} {content.title}</h3>
                  <div class="author">{content.author}</div>
                </div>
                <div class="content-meta">
                  <div>Type: {content.type}</div>
                  <div class="badges">
                    <span class="badge status-{getStatusBadge(content.status)}">{content.status}</span>
                    <span class="badge state-{getStateBadge(content.state)}">{content.state}</span>
                  </div>
                </div>
                <p class="content-description">{content.description}</p>
                {#if content.url}
                  <div class="source">Source: <a href={content.url} target="_blank">{content.url}</a></div>
                {/if}
                {#if content.fileKey}
                  <div class="file">File: {content.fileKey}</div>
                {/if}
                <div class="content-actions">
                  <button onclick={() => handleEditContent(content)}>Edit</button>
                  <button onclick={() => handleDeleteContent(content)} class="delete-btn">Delete</button>
                </div>
              </div>
            {/each}
          </div>
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
      <div class="footer-links">
        <a href="#api-docs">API Docs</a>
        <a href="#mcp-tools">MCP Tools</a>
        <a href="#document-processing">Document Processing</a>
      </div>
    </div>
  </footer>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.2);
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
    color: #333;
  }

  .header nav {
    display: flex;
    gap: 2rem;
  }

  .header nav a {
    color: #666;
    text-decoration: none;
    font-weight: 500;
    transition: color 0.2s;
  }

  .header nav a:hover {
    color: #333;
  }

  .status {
    background: #10b981;
    color: white;
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
    color: white;
  }

  .hero h1 {
    font-size: 3rem;
    margin: 0 0 1rem 0;
    font-weight: 800;
  }

  .hero p {
    font-size: 1.25rem;
    opacity: 0.9;
    max-width: 600px;
    margin: 0 auto;
  }

  .content-section {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 1rem;
    padding: 2rem;
    margin-bottom: 2rem;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  }

  .stats-grid {
    margin-bottom: 2rem;
  }

  .stat-card {
    background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
    border-radius: 0.75rem;
    padding: 1.5rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .stat-card h2 {
    margin: 0 0 1rem 0;
    color: #1e293b;
    font-size: 1.5rem;
  }

  .stats {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
  }

  .stat {
    color: #475569;
    font-size: 0.875rem;
  }

  .stat strong {
    color: #1e293b;
    font-size: 1.5rem;
    display: block;
  }

  .content-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .search-filters {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .search-filters input,
  .search-filters select {
    padding: 0.5rem 1rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    font-size: 0.875rem;
  }

  .add-button {
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s;
  }

  .add-button:hover {
    transform: translateY(-1px);
  }

  .content-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: 1.5rem;
  }

  .content-card {
    background: white;
    border-radius: 0.75rem;
    padding: 1.5rem;
    border: 1px solid #e5e7eb;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .content-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 25px -3px rgba(0, 0, 0, 0.1);
  }

  .content-header {
    margin-bottom: 1rem;
  }

  .content-header h3 {
    margin: 0 0 0.25rem 0;
    color: #1e293b;
    font-size: 1.25rem;
  }

  .author {
    color: #64748b;
    font-size: 0.875rem;
  }

  .content-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: #64748b;
  }

  .badges {
    display: flex;
    gap: 0.5rem;
  }

  .badge {
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .status-published { background: #dcfce7; color: #166534; }
  .status-draft { background: #fef3c7; color: #92400e; }
  .status-archived { background: #f3f4f6; color: #374151; }

  .state-highlighted { background: #fef3c7; color: #92400e; }
  .state-active { background: #dcfce7; color: #166534; }
  .state-deprecated { background: #fee2e2; color: #991b1b; }

  .content-description {
    color: #475569;
    line-height: 1.6;
    margin-bottom: 1rem;
  }

  .source, .file {
    font-size: 0.75rem;
    color: #64748b;
    margin-bottom: 0.5rem;
  }

  .source a {
    color: #3b82f6;
    text-decoration: none;
  }

  .content-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .content-actions button {
    padding: 0.5rem 1rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    background: white;
    color: #374151;
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .content-actions button:hover {
    background: #f9fafb;
    border-color: #9ca3af;
  }

  .delete-btn:hover {
    background: #fee2e2 !important;
    border-color: #dc2626 !important;
    color: #dc2626 !important;
  }

  /* Form Modal Styles */
  .form-modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .form-container {
    background: white;
    border-radius: 1rem;
    padding: 2rem;
    max-width: 600px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }

  .form-container h3 {
    margin: 0 0 1.5rem 0;
    color: #1e293b;
    font-size: 1.5rem;
  }

  .form-container form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .form-container label {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: #374151;
    font-weight: 500;
    font-size: 0.875rem;
  }

  .form-container input,
  .form-container select,
  .form-container textarea {
    padding: 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .form-container input:focus,
  .form-container select:focus,
  .form-container textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .form-container textarea {
    resize: vertical;
    min-height: 100px;
  }

  .form-actions {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
    justify-content: flex-end;
  }

  .save-button {
    background: linear-gradient(135deg, #10b981 0%, #047857 100%);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s;
  }

  .save-button:hover {
    transform: translateY(-1px);
  }

  .cancel-button {
    background: #f3f4f6;
    color: #374151;
    border: 1px solid #d1d5db;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .cancel-button:hover {
    background: #e5e7eb;
    border-color: #9ca3af;
  }

  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1.5rem;
    margin-top: 2rem;
  }

  .feature {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 0.75rem;
    padding: 1.5rem;
    text-align: center;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .feature h3 {
    margin: 0 0 0.75rem 0;
    color: #1e293b;
    font-size: 1.125rem;
  }

  .feature p {
    color: #475569;
    font-size: 0.875rem;
    line-height: 1.6;
    margin: 0;
  }

  .footer {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-top: 1px solid rgba(255, 255, 255, 0.2);
    padding: 1.5rem 0;
    margin-top: auto;
  }

  .footer .container {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .footer p {
    margin: 0;
    color: #64748b;
    font-size: 0.875rem;
  }

  .footer-links {
    display: flex;
    gap: 1.5rem;
  }

  .footer-links a {
    color: #64748b;
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.2s;
  }

  .footer-links a:hover {
    color: #1e293b;
  }

  .error {
    color: #dc2626;
    text-align: center;
    padding: 2rem;
  }

  @media (max-width: 768px) {
    .header .container {
      flex-direction: column;
      gap: 1rem;
    }

    .hero h1 {
      font-size: 2rem;
    }

    .hero p {
      font-size: 1rem;
    }

    .content-controls {
      flex-direction: column;
      align-items: stretch;
    }

    .content-grid {
      grid-template-columns: 1fr;
    }

    .footer .container {
      flex-direction: column;
      text-align: center;
    }
  }
</style>