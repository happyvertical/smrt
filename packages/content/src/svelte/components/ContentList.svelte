<script lang="ts">
import type { Snippet } from 'svelte';
import ImageThumbnail from './ImageThumbnail.svelte';

let {
  apiBaseUrl = '/api/v1',
  contents,
  type = undefined,
  onEdit,
  onDelete,
  onAdd,
  controls,
  getViewHref = undefined,
} = $props<{
  apiBaseUrl?: string;
  contents: any[];
  type?: string;
  onEdit: (content: any) => void;
  onDelete: (content: any) => void;
  onAdd: () => void;
  controls?: Snippet;
  getViewHref?: (content: any) => string | null;
}>();

let searchTerm = $state('');
let selectedType = $state('All Types');
let selectedStatus = $state('All Statuses');
let viewMode = $state<'grid' | 'detailed' | 'compact'>('grid');

$effect(() => {
  selectedType = type || 'All Types';
});

const filteredContents = $derived(
  contents.filter((content: any) => {
    const matchesSearch =
      searchTerm === '' ||
      content.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      content.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      content.author?.toLowerCase().includes(searchTerm.toLowerCase());

    const isLockedType = !!type;
    const matchesType = isLockedType
      ? content.type === type
      : selectedType === 'All Types' ||
        (selectedType === 'Articles' && content.type === 'article') ||
        (selectedType === 'Documents' && content.type === 'document') ||
        (selectedType === 'Mirrors' && content.type === 'mirror');

    const matchesStatus =
      selectedStatus === 'All Statuses' ||
      content.status.toLowerCase() === selectedStatus.toLowerCase();

    return matchesSearch && matchesType && matchesStatus;
  }),
);

function getTypeIcon(t: string) {
  switch (t) {
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

function getStatusBadge(s: string) {
  switch (s) {
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

function getStateBadge(s: string) {
  switch (s) {
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

function handleDeleteContent(content: any) {
  if (confirm(`Are you sure you want to delete "${content.title}"?`)) {
    onDelete(content);
  }
}
</script>

<div class="content-list-wrapper">
  
  <div class="content-controls">
    <div class="search-filters">
      <input type="text" placeholder="Search contents..." bind:value={searchTerm} />
      
      {#if !type}
        <select bind:value={selectedType}>
          <option>All Types</option>
          <option>Articles</option>
          <option>Documents</option>
          <option>Mirrors</option>
        </select>
      {/if}
      
      <select bind:value={selectedStatus}>
        <option>All Statuses</option>
        <option>Published</option>
        <option>Draft</option>
        <option>Archived</option>
      </select>
      
      {#if controls}
        {@render controls()}
      {/if}
    </div>
    
    <div class="actions-group">
      <div class="view-toggles">
        <button 
          class:active={viewMode === 'grid'} 
          onclick={() => viewMode = 'grid'}
          title="Grid View"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
        </button>
        <button 
          class:active={viewMode === 'detailed'} 
          onclick={() => viewMode = 'detailed'}
          title="Detailed List"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
        </button>
        <button 
          class:active={viewMode === 'compact'} 
          onclick={() => viewMode = 'compact'}
          title="Compact List"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
      </div>
      
      <button class="add-button" onclick={onAdd}>
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Add Content
      </button>
    </div>
  </div>

  {#if filteredContents.length === 0}
    <div class="empty-state">
      No contents match your filters.
    </div>
  {:else if viewMode === 'compact'}
    <div class="content-table-wrapper">
      <table class="content-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Title</th>
            <th>Author</th>
            <th>Status</th>
            <th>State</th>
            <th class="actions-col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredContents as content (content.id)}
            <tr>
              <td class="icon-cell" title={content.type}>{getTypeIcon(content.type)} {content.type}</td>
              <td class="title-cell"><strong>{content.title}</strong></td>
              <td>{content.author || '-'}</td>
              <td><span class="badge status-{getStatusBadge(content.status)}">{content.status}</span></td>
              <td><span class="badge state-{getStateBadge(content.state)}">{content.state}</span></td>
              <td class="actions-cell">
                {#if getViewHref?.(content)}
                  <a class="icon-btn" href={getViewHref(content) || '#'} title="View published article">🔎</a>
                {/if}
                <button class="icon-btn" onclick={() => onEdit(content)} title="Edit">✏️</button>
                <button class="icon-btn delete-icon" onclick={() => handleDeleteContent(content)} title="Delete">🗑️</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <!-- Grid and Detailed List Modes -->
    <div class="content-{viewMode}">
      {#each filteredContents as content (content.id)}
        <div class="content-card">
          {#if content.thumbnailAssetId}
            <div class="card-thumbnail">
              <ImageThumbnail
                apiBaseUrl={apiBaseUrl}
                assetId={content.thumbnailAssetId}
              />
            </div>
          {/if}
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
          
          <div class="content-footer">
            <div class="meta-links">
              {#if content.url}
                <div class="source">Source: <a href={content.url} target="_blank">{content.url}</a></div>
              {/if}
              {#if content.fileKey}
                <div class="file">File: {content.fileKey}</div>
              {/if}
            </div>
            
            <div class="content-actions">
              {#if getViewHref?.(content)}
                <a href={getViewHref(content) || '#'} class="view-btn">View Article</a>
              {/if}
              <button onclick={() => onEdit(content)}>Edit</button>
              <button onclick={() => handleDeleteContent(content)} class="delete-btn">Delete</button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
  
</div>

<style>
  .content-list-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .content-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
    flex-wrap: wrap;
    gap: 1.5rem;
    background: var(--smrt-color-surface);
    padding: 1rem 1.5rem;
    border-radius: 0.75rem;
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0,0,0,0.1));
  }

  .search-filters {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .search-filters input,
  .search-filters select {
    padding: 0.5rem 1rem;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.5rem;
    font-size: 0.875rem;
    height: 38px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }

  .search-filters input:focus,
  .search-filters select:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
  }

  .actions-group {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .view-toggles {
    display: flex;
    background: var(--smrt-color-surface-container-low);
    border-radius: 0.5rem;
    padding: 0.25rem;
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .view-toggles button {
    background: transparent;
    border: none;
    padding: 0.4rem;
    color: var(--smrt-color-on-surface-variant);
    border-radius: 0.375rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .view-toggles button:hover {
    color: var(--smrt-color-on-surface);
    background: rgba(0,0,0,0.05);
  }

  .view-toggles button.active {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-1, 0 1px 2px rgba(0,0,0,0.1));
  }

  .add-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
    color: white;
    border: none;
    padding: 0.5rem 1.25rem;
    height: 38px;
    border-radius: 0.5rem;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .add-button:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 6px -1px rgba(59,130,246,0.5);
  }

  /* Shared Card Styles */
  .content-card {
    background: var(--smrt-color-surface);
    border-radius: 0.75rem;
    padding: 1.5rem;
    border: 1px solid var(--smrt-color-outline-variant);
    transition: transform 0.2s, box-shadow 0.2s;
    display: flex;
    flex-direction: column;
  }

  .content-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--smrt-elevation-3, 0 10px 25px -3px rgba(0, 0, 0, 0.1));
  }

  .card-thumbnail {
    width: calc(100% + 3rem);
    margin: -1.5rem -1.5rem 1rem -1.5rem;
    height: 160px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    overflow: hidden;
    background: var(--smrt-color-surface-container-high, #242424);
  }

  .content-header {
    margin-bottom: 1rem;
  }

  .content-header h3 {
    margin: 0 0 0.25rem 0;
    color: var(--smrt-color-on-surface);
    font-size: 1.25rem;
    line-height: 1.3;
  }

  .author {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
  }

  .content-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge {
    padding: 0.25rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .status-published { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
  .status-draft { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
  .status-archived { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }

  .state-highlighted { background: #fef3c7; color: #92400e; border: 1px solid #fde68a;}
  .state-active { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
  .state-deprecated { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }

  .content-description {
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.6;
    margin-bottom: 1.5rem;
    flex: 1;
  }

  .content-footer {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: auto;
  }

  .meta-links {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .source, .file {
    font-size: 0.75rem;
    color: #64748b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .source a {
    color: #3b82f6;
    text-decoration: none;
  }
  
  .source a:hover {
    text-decoration: underline;
  }

  .content-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.5rem;
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 1rem;
  }

  .content-actions button,
  .content-actions a {
    flex: 1;
    padding: 0.5rem 1rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
    text-decoration: none;
  }

  .content-actions button:hover,
  .content-actions a:hover {
    background: var(--smrt-color-surface-variant);
    border-color: var(--smrt-color-outline);
  }

  .view-btn {
    color: var(--smrt-color-primary) !important;
  }

  .delete-btn {
    color: #dc2626 !important;
  }

  .delete-btn:hover {
    background: #fef2f2 !important;
    border-color: #fecaca !important;
  }

  /* GRID View Specifics */
  .content-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1.5rem;
  }

  /* DETAILED View Specifics */
  .content-detailed {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  
  .content-detailed .content-card {
    flex-direction: row;
    align-items: stretch;
    gap: 2rem;
  }

  .content-detailed .content-header {
    flex: 1;
    min-width: 250px;
  }

  .content-detailed .content-description {
    flex: 2;
    margin-bottom: 0;
    border-left: 1px solid var(--smrt-color-outline-variant);
    padding-left: 2rem;
  }

  .content-detailed .content-footer {
    flex-direction: column;
    justify-content: flex-start;
    align-items: flex-end;
    min-width: 200px;
    margin-top: 0;
  }

  .content-detailed .content-actions {
    margin-top: auto;
    border-top: none;
    padding-top: 0;
    width: 100%;
  }

  /* COMPACT View Specifics */
  .content-table-wrapper {
    background: var(--smrt-color-surface);
    border-radius: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant);
    overflow: hidden;
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0,0,0,0.05));
  }

  .content-table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }

  .content-table th {
    background: var(--smrt-color-surface-container-low);
    padding: 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--smrt-color-on-surface-variant);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .content-table td {
    padding: 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    color: var(--smrt-color-on-surface);
    font-size: 0.875rem;
    vertical-align: middle;
  }

  .content-table tr:last-child td {
    border-bottom: none;
  }

  .content-table tr:hover {
    background: var(--smrt-color-surface-container-low);
  }

  .icon-cell {
    white-space: nowrap;
    text-transform: capitalize;
    color: var(--smrt-color-on-surface-variant);
  }

  .title-cell strong {
    color: var(--smrt-color-on-surface);
    font-weight: 600;
  }

  .actions-col {
    width: 100px;
    text-align: right;
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }

  .icon-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 1.1rem;
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: background 0.2s;
    opacity: 0.7;
  }

  .icon-btn:hover {
    background: var(--smrt-color-surface-variant);
    opacity: 1;
  }

  .delete-icon:hover {
    background: var(--smrt-color-error-container);
  }

  .empty-state {
    background: var(--smrt-color-surface);
    padding: 4rem;
    text-align: center;
    border-radius: 0.75rem;
    border: 1px dashed var(--smrt-color-outline);
    color: var(--smrt-color-on-surface-variant);
    font-size: 1.1rem;
  }

  .source, .file {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
