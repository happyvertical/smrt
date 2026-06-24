<script lang="ts">
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import { M } from '../i18n.contribution.js';
import ImageThumbnail from './ImageThumbnail.svelte';

const { t } = useI18n();

let {
  apiBaseUrl = '/api/v1',
  contents,
  type = undefined,
  defaultViewMode = 'grid',
  onEdit,
  onDelete,
  onAdd,
  controls,
  getViewHref = undefined,
} = $props<{
  apiBaseUrl?: string;
  contents: any[];
  type?: string;
  defaultViewMode?: 'grid' | 'detailed' | 'compact';
  onEdit: (content: any) => void;
  onDelete: (content: any) => void;
  onAdd: () => void;
  controls?: Snippet;
  getViewHref?: (content: any) => string | null;
}>();

let searchTerm = $state('');
let selectedType = $state('All Types');
let selectedStatus = $state('All Statuses');
let viewMode: 'grid' | 'detailed' | 'compact' = $state(
  untrack(() => defaultViewMode),
);

$effect(() => {
  selectedType = type || 'All Types';
});

function getTextValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getDisplayTitle(content: any): string {
  return getTextValue(content.title) || 'Untitled content';
}

function getDisplayDescription(content: any): string {
  return getTextValue(content.description);
}

function getDisplayAuthor(content: any): string {
  return getTextValue(content.author);
}

function getNormalizedType(value: unknown): string {
  return getTextValue(value).toLowerCase() || 'content';
}

const filteredContents = $derived(
  contents.filter((content: any) => {
    const title = getDisplayTitle(content);
    const description = getDisplayDescription(content);
    const author = getDisplayAuthor(content);

    const matchesSearch =
      searchTerm === '' ||
      title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      author.toLowerCase().includes(searchTerm.toLowerCase());

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

function getTypeLabel(value: unknown) {
  switch (getNormalizedType(value)) {
    case 'article':
      return 'Article';
    case 'mirror':
      return 'Mirror';
    case 'document':
      return 'Document';
    default:
      return 'Content';
  }
}

function getStatusBadge(value: unknown) {
  switch (getTextValue(value).toLowerCase()) {
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

function getStateBadge(value: unknown) {
  switch (getTextValue(value).toLowerCase()) {
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

let pendingDelete = $state<any | null>(null);

function handleDeleteContent(content: any) {
  pendingDelete = content;
}

function confirmDelete() {
  const target = pendingDelete;
  pendingDelete = null;
  if (target) {
    onDelete(target);
  }
}

function cancelDelete() {
  pendingDelete = null;
}
</script>

<div class="content-list-wrapper">
  
  <div class="content-controls">
    <div class="search-filters">
      <input type="text" placeholder={t(M['content.content_list.search_placeholder'])} bind:value={searchTerm} />
      
      {#if !type}
        <select bind:value={selectedType}>
          <option value="All Types">{t(M['content.content_list.all_types'])}</option>
          <option value="Articles">Articles</option>
          <option value="Documents">Documents</option>
          <option value="Mirrors">Mirrors</option>
        </select>
      {/if}
      
      <select bind:value={selectedStatus}>
        <option value="All Statuses">{t(M['content.content_list.all_statuses'])}</option>
        <option value="Published">Published</option>
        <option value="Draft">Draft</option>
        <option value="Archived">Archived</option>
      </select>
      
      {#if controls}
        {@render controls()}
      {/if}
    </div>
    
    <div class="actions-group">
      <div class="view-toggles">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={`view-toggle-btn${viewMode === 'grid' ? ' view-toggle-btn--active' : ''}`}
          aria-pressed={viewMode === 'grid'}
          onclick={() => viewMode = 'grid'}
          aria-label={t(M['content.content_list.grid_view'])}
          title={t(M['content.content_list.grid_view'])}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={`view-toggle-btn${viewMode === 'detailed' ? ' view-toggle-btn--active' : ''}`}
          aria-pressed={viewMode === 'detailed'}
          onclick={() => viewMode = 'detailed'}
          aria-label={t(M['content.content_list.detailed_list'])}
          title={t(M['content.content_list.detailed_list'])}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={`view-toggle-btn${viewMode === 'compact' ? ' view-toggle-btn--active' : ''}`}
          aria-pressed={viewMode === 'compact'}
          onclick={() => viewMode = 'compact'}
          aria-label={t(M['content.content_list.compact_list'])}
          title={t(M['content.content_list.compact_list'])}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none">
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </Button>
      </div>

      <Button variant="ghost" class="add-button" type="button" onclick={() => onAdd()}>
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        {t(M['content.content_list.add_content'])}
      </Button>
    </div>
  </div>

  {#if filteredContents.length === 0}
    <div class="empty-state">
      {t(M['content.content_list.empty'])}
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
              <td class="type-cell">
                <span class={`type-pill type-pill--${getNormalizedType(content.type)}`}>
                  {getTypeLabel(content.type)}
                </span>
              </td>
              <td class="title-cell"><strong>{getDisplayTitle(content)}</strong></td>
              <td>{getDisplayAuthor(content) || '-'}</td>
              <td><span class="badge status-{getStatusBadge(content.status)}">{content.status}</span></td>
              <td><span class="badge state-{getStateBadge(content.state)}">{content.state}</span></td>
              <td class="actions-cell">
                {#if getViewHref?.(content)}
                  <a class="icon-btn" href={getViewHref(content) || '#'} title={t(M['content.content_list.view_published_article'])} aria-label={t(M['content.content_list.view_published_article'])}>🔎</a>
                {/if}
                <Button variant="ghost" size="sm" class="icon-btn" type="button" onclick={() => onEdit(content)} title={t(M['content.content_list.edit'])} aria-label={t(M['content.content_list.edit'])}>✏️</Button>
                <Button variant="ghost" size="sm" class="icon-btn delete-icon" type="button" onclick={() => handleDeleteContent(content)} title={t(M['content.content_list.delete'])} aria-label={t(M['content.content_list.delete'])}>🗑️</Button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if viewMode === 'detailed'}
    <div class="content-detailed">
      {#each filteredContents as content (content.id)}
        <article class="content-row">
          <div class="content-row__main">
            <div class="content-row__eyebrow">
              <span class={`type-pill type-pill--${getNormalizedType(content.type)}`}>
                {getTypeLabel(content.type)}
              </span>
              {#if getDisplayAuthor(content)}
                <span class="content-row__author">By {getDisplayAuthor(content)}</span>
              {/if}
            </div>

            <h3>{getDisplayTitle(content)}</h3>

            {#if getDisplayDescription(content)}
              <p class="content-row__description">{getDisplayDescription(content)}</p>
            {/if}

            {#if content.url || content.fileKey}
              <div class="content-row__links">
                {#if content.url}
                  <a href={content.url} target="_blank" rel="noreferrer">
                    {t(M['content.content_list.source_material'])}
                  </a>
                {/if}
                {#if content.fileKey}
                  <span>{content.fileKey}</span>
                {/if}
              </div>
            {/if}
          </div>

          <div class="content-row__meta">
            <span class="meta-label">Status</span>
            <span class="badge status-{getStatusBadge(content.status)}">{content.status}</span>
            <span class="meta-label">State</span>
            <span class="badge state-{getStateBadge(content.state)}">{content.state}</span>
          </div>

          <div class="content-row__actions">
            {#if getViewHref?.(content)}
              <a href={getViewHref(content) || '#'} class="quiet-action">{t(M['content.content_list.view_article'])}</a>
            {/if}
            <Button variant="ghost" type="button" class="quiet-action" onclick={() => onEdit(content)}>{t(M['content.content_list.edit'])}</Button>
            <Button
              variant="ghost"
              type="button"
              class="quiet-action quiet-action--danger"
              onclick={() => handleDeleteContent(content)}
            >
              {t(M['content.content_list.delete'])}
            </Button>
          </div>
        </article>
      {/each}
    </div>
  {:else}
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
            <div class="content-header__eyebrow">
              <span class={`type-pill type-pill--${getNormalizedType(content.type)}`}>
                {getTypeLabel(content.type)}
              </span>
              {#if getDisplayAuthor(content)}
                <div class="author">{getDisplayAuthor(content)}</div>
              {/if}
            </div>
            <h3>{getDisplayTitle(content)}</h3>
          </div>
          
          <div class="content-meta">
            <div>{getTypeLabel(content.type)}</div>
            <div class="badges">
              <span class="badge status-{getStatusBadge(content.status)}">{content.status}</span>
              <span class="badge state-{getStateBadge(content.state)}">{content.state}</span>
            </div>
          </div>
          
          <p class="content-description">{getDisplayDescription(content)}</p>
          
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
                <a href={getViewHref(content) || '#'} class="view-btn">{t(M['content.content_list.view_article_button'])}</a>
              {/if}
              <Button variant="ghost" type="button" class="content-action-btn" onclick={() => onEdit(content)}>{t(M['content.content_list.edit'])}</Button>
              <Button variant="ghost" type="button" class="content-action-btn delete-btn" onclick={() => handleDeleteContent(content)}>{t(M['content.content_list.delete'])}</Button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

</div>

<ConfirmDialog
  open={pendingDelete !== null}
  title={t(M['content.content_list.delete_confirm_title'])}
  message={t(M['content.content_list.delete_confirm_message'], {
    title: pendingDelete ? getDisplayTitle(pendingDelete) : '',
  })}
  confirmLabel={t(M['content.content_list.delete'])}
  cancelLabel={t(M['content.content_list.cancel'])}
  destructive
  onconfirm={confirmDelete}
  oncancel={cancelDelete}
/>

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
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    gap: 1rem;
    background: var(--smrt-color-surface);
    padding: 0.9rem 1.1rem;
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
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.5rem;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    height: 38px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }

  .search-filters input:focus,
  .search-filters select:focus {
    outline: none;
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--smrt-color-primary) 20%, transparent);
  }

  .actions-group {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .view-toggles {
    display: flex;
    background: var(--smrt-color-surface-container-low);
    border-radius: 0.5rem;
    padding: 0.25rem;
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .view-toggles :global(.view-toggle-btn) {
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

  .view-toggles :global(.view-toggle-btn:hover) {
    color: var(--smrt-color-on-surface);
    background: color-mix(in srgb, var(--smrt-color-shadow) 5%, transparent);
  }

  .view-toggles :global(.view-toggle-btn.view-toggle-btn--active) {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-1, 0 1px 2px rgba(0,0,0,0.1));
  }

  .actions-group :global(.add-button) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: linear-gradient(
      135deg,
      var(--smrt-color-primary) 0%,
      color-mix(in srgb, var(--smrt-color-primary) 80%, black) 100%
    );
    color: var(--smrt-color-on-primary);
    border: none;
    padding: 0.5rem 1rem;
    height: 38px;
    border-radius: 0.5rem;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .actions-group :global(.add-button:hover) {
    transform: translateY(-1px);
    box-shadow: 0 4px 6px -1px color-mix(in srgb, var(--smrt-color-primary) 50%, transparent);
  }

  .content-header__eyebrow,
  .content-row__eyebrow {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
    margin-bottom: 0.55rem;
  }

  .type-pill {
    display: inline-flex;
    align-items: center;
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.2rem 0.65rem;
    font-size: var(--smrt-typography-label-medium-size, 0.72rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.06em);
    text-transform: uppercase;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
  }

  .type-pill--article {
    background: color-mix(in srgb, var(--smrt-color-primary) 11%, transparent);
    color: var(--smrt-color-primary);
  }

  .type-pill--document {
    background: color-mix(in srgb, var(--smrt-color-tertiary, #0f766e) 12%, transparent);
    color: var(--smrt-color-tertiary, #0f766e);
  }

  .type-pill--mirror {
    background: color-mix(in srgb, var(--smrt-color-secondary, #9333ea) 12%, transparent);
    color: var(--smrt-color-secondary, #9333ea);
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
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    line-height: var(--smrt-typography-title-large-line-height, 1.3);
  }

  .author {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .content-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge {
    padding: 0.25rem 0.6rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
  }

  .status-published { background: var(--smrt-color-success-container); color: var(--smrt-color-on-success-container); border: 1px solid var(--smrt-color-success); }
  .status-draft { background: var(--smrt-color-warning-container); color: var(--smrt-color-on-warning-container); border: 1px solid var(--smrt-color-warning); }
  .status-archived { background: var(--smrt-color-surface-container); color: var(--smrt-color-on-surface-variant); border: 1px solid var(--smrt-color-outline-variant); }

  .state-highlighted { background: var(--smrt-color-warning-container); color: var(--smrt-color-on-warning-container); border: 1px solid var(--smrt-color-warning);}
  .state-active { background: var(--smrt-color-success-container); color: var(--smrt-color-on-success-container); border: 1px solid var(--smrt-color-success); }
  .state-deprecated { background: var(--smrt-color-error-container); color: var(--smrt-color-on-error-container); border: 1px solid var(--smrt-color-error); }

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
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .source a {
    color: var(--smrt-color-primary);
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

  .content-actions :global(.content-action-btn),
  .content-actions a {
    flex: 1;
    padding: 0.5rem 1rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
    text-decoration: none;
  }

  .content-actions :global(.content-action-btn:hover),
  .content-actions a:hover {
    background: var(--smrt-color-surface-variant);
    border-color: var(--smrt-color-outline);
  }

  .view-btn {
    color: var(--smrt-color-primary) !important;
  }

  .content-actions :global(.delete-btn) {
    color: var(--smrt-color-error) !important;
  }

  .content-actions :global(.delete-btn:hover) {
    background: var(--smrt-color-error-container) !important;
    border-color: var(--smrt-color-error) !important;
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
    gap: 0;
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .content-row {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) auto auto;
    gap: 1.25rem;
    align-items: start;
    padding: 1.1rem 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .content-row h3 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    line-height: var(--smrt-typography-title-medium-line-height, 1.3);
  }

  .content-row__description {
    margin: 0.45rem 0 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.55;
  }

  .content-row__meta {
    display: grid;
    gap: 0.45rem;
    justify-items: start;
    align-content: start;
    min-width: 7.25rem;
  }

  .meta-label {
    font-size: var(--smrt-typography-label-medium-size, 0.72rem);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.06em);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
  }

  .content-row__actions {
    display: grid;
    gap: 0.55rem;
    justify-items: stretch;
    min-width: 8.5rem;
  }

  .content-row__actions :global(.quiet-action) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.4rem;
    padding: 0 0.85rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid var(--smrt-color-outline-variant);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-decoration: none;
    cursor: pointer;
  }

  .content-row__actions :global(.quiet-action:hover) {
    background: var(--smrt-color-surface-container-low);
  }

  .content-row__actions :global(.quiet-action--danger) {
    color: var(--smrt-color-error);
  }

  .content-row__links {
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    margin-top: 0.8rem;
    font-size: var(--smrt-typography-body-medium-size, 0.82rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .content-row__links a {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .content-row__author {
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
    color: var(--smrt-color-on-surface-variant);
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
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface-variant);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .content-table td {
    padding: 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    vertical-align: middle;
  }

  .content-table tr:last-child td {
    border-bottom: none;
  }

  .content-table tr:hover {
    background: var(--smrt-color-surface-container-low);
  }

  .type-cell {
    white-space: nowrap;
  }

  .title-cell strong {
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .actions-col {
    width: 100px;
    text-align: right;
  }

  .actions-cell {
    text-align: right;
    white-space: nowrap;
  }

  .actions-cell :global(.icon-btn) {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: background 0.2s;
    opacity: 0.7;
  }

  .actions-cell :global(.icon-btn:hover) {
    background: var(--smrt-color-surface-variant);
    opacity: 1;
  }

  .actions-cell :global(.delete-icon:hover) {
    background: var(--smrt-color-error-container);
  }

  .empty-state {
    background: var(--smrt-color-surface);
    padding: 4rem;
    text-align: center;
    border-radius: 0.75rem;
    border: 1px dashed var(--smrt-color-outline);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1.1rem);
  }

  .source, .file {
    color: var(--smrt-color-on-surface-variant);
  }

  @media (max-width: 960px) {
    .content-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.9rem;
    }

    .content-row__actions {
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      min-width: 0;
    }
  }

  @media (max-width: 720px) {
    .content-controls {
      align-items: stretch;
    }

    .search-filters,
    .actions-group {
      width: 100%;
    }

    .search-filters input,
    .search-filters select,
    .add-button {
      width: 100%;
    }

    .actions-group {
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .content-row__actions {
      grid-auto-flow: row;
    }
  }
</style>
