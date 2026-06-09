<script lang="ts">
import { onMount } from 'svelte';
import type { ContentData } from '../../mock-smrt-client.js';
import { createClient } from '../../mock-smrt-client.js';
import ContentEditor from '../components/ContentEditor.svelte';
import ContentList from '../components/ContentList.svelte';
import GovernedContentEditor from '../components/GovernedContentEditor.svelte';
import {
  buildPublishedArticlePath,
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
  getContentRouteHref,
} from './shared.js';

interface ContentWorkspaceRouteProps {
  navigation?: ContentRouteNavigationItem[];
  apiBaseUrl?: string;
  getPublishedHref?: (content: ContentData) => string | null;
  embedded?: boolean;
}

function defaultGetPublishedHref(content: ContentData): string | null {
  if (content.status !== 'published' || !content.slug) {
    return null;
  }

  return buildPublishedArticlePath(content.slug);
}

let {
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
  apiBaseUrl = '/api/v1',
  getPublishedHref = defaultGetPublishedHref,
  embedded = false,
}: ContentWorkspaceRouteProps = $props();

const client = $derived(createClient(apiBaseUrl));
const governanceHref = $derived(
  getContentRouteHref(navigation, CONTENT_ROUTE_IDS.governance),
);

let contents = $state<ContentData[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let showAddForm = $state(false);
let editingContent = $state<ContentData | null>(null);
let editorMode = $state<'generic' | 'governed'>('generic');

const stats = $derived({
  total: contents.length,
  published: contents.filter((content) => content.status === 'published')
    .length,
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
    error = err.message || 'Failed to load contents.';
  } finally {
    loading = false;
  }
}

async function handleSaveContent(formData: ContentData) {
  try {
    const currentEditingContent = editingContent;
    if (currentEditingContent?.id) {
      const response = await client.contents.update(
        currentEditingContent.id,
        formData,
      );
      const index = contents.findIndex(
        (content) => content.id === currentEditingContent.id,
      );

      if (index >= 0) {
        contents[index] = response.data;
        contents = [...contents];
      } else {
        contents = [response.data, ...contents];
      }
    } else {
      const response = await client.contents.create(formData);
      contents = [response.data, ...contents];
    }

    closeForms();
  } catch (err: any) {
    error = err.message || 'Failed to save content.';
  }
}

async function handleDeleteContent(content: ContentData) {
  try {
    await client.contents.delete(content.id || '');
    contents = contents.filter((item) => item.id !== content.id);
  } catch (err: any) {
    error = err.message || 'Failed to delete content.';
  }
}

async function handleEditContent(content: ContentData) {
  try {
    const response = await client.contents.get(content.id || '');
    editingContent = response.data;
    const governance = await client.contents.resolveGovernance({
      type: response.data.type,
      variant: response.data.variant,
    });
    editorMode = governance.data.isGoverned ? 'governed' : 'generic';
  } catch (err) {
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
</script>

<div class:workspace-shell={true} class:workspace-shell--embedded={embedded}>
  <header class="workspace-header">
    <div class="workspace-header__copy">
      <div class="eyebrow">Content operations</div>
      <h1>Content workspace</h1>
      <p>
        Search, edit, and publish the tenant's articles, agendas, documents,
        and mirrored records from one workspace.
      </p>
    </div>

    <nav class="workspace-nav" aria-label="Content navigation">
      {#each navigation as item (item.routeId)}
        <a
          href={item.href}
          aria-current={item.routeId === CONTENT_ROUTE_IDS.workspace
            ? 'page'
            : undefined}
        >
          {item.label}
        </a>
      {/each}
    </nav>
  </header>

  <main class="workspace-main">
    <section class="callout-grid">
      <article class="callout-card">
        <strong>{stats.total}</strong>
        <span>Records in the library</span>
      </article>
      <article class="callout-card">
        <strong>{stats.published}</strong>
        <span>Published right now</span>
      </article>
    </section>

    {#if loading}
      <section class="panel">
        <p>Loading contents...</p>
      </section>
    {:else if error}
      <section class="panel panel--error">
        <p><strong>Error:</strong> {error}</p>
        <button type="button" onclick={loadContents}>Try again</button>
      </section>
    {:else if showAddForm || editingContent}
      <section class="panel">
        {#if editorMode === 'governed'}
          <GovernedContentEditor
            {apiBaseUrl}
            content={editingContent || undefined}
            contentId={editingContent?.id || 'new'}
            onSave={handleSaveContent}
            onCancel={closeForms}
          />
        {:else}
          <ContentEditor
            {apiBaseUrl}
            content={editingContent || undefined}
            contentId={editingContent?.id || 'new'}
            onSave={handleSaveContent}
            onCancel={closeForms}
          />
        {/if}
      </section>
    {:else}
      <section class="panel">
        <ContentList
          {apiBaseUrl}
          {contents}
          defaultViewMode="detailed"
          getViewHref={getPublishedHref}
          onEdit={handleEditContent}
          onDelete={handleDeleteContent}
          onAdd={handleAddContent}
        >
          {#snippet controls()}
            <div class="workspace-controls">
              <button
                type="button"
                class="secondary-action"
                onclick={handleAddGovernedContent}
              >
                Create governed article
              </button>
              <a class="inline-link" href={governanceHref}>
                Review governance settings
              </a>
            </div>
          {/snippet}
        </ContentList>
      </section>
    {/if}
  </main>
</div>

<style>
  :global(body:has(.workspace-shell:not(.workspace-shell--embedded))) {
    margin: 0;
    font-family:
      var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont,
      'Segoe UI', Roboto, sans-serif);
    background:
      radial-gradient(
        circle at top,
        color-mix(in srgb, var(--smrt-color-primary) 10%, transparent),
        transparent 34%
      ),
      var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    min-height: 100vh;
  }

  .workspace-shell {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
    display: grid;
    gap: 1.5rem;
    max-width: 1280px;
    margin: 0 auto;
  }

  .workspace-shell--embedded {
    min-height: auto;
    padding: 0;
    max-width: none;
  }

  .workspace-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .workspace-header__copy {
    max-width: 44rem;
  }

  .eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .workspace-header h1 {
    margin: 0.35rem 0 0.65rem;
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }

  .workspace-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    max-width: 38rem;
  }

  .workspace-nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .workspace-nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: 600;
  }

  .workspace-nav a[aria-current='page'] {
    color: var(--smrt-color-primary);
    border-color: color-mix(
      in srgb,
      var(--smrt-color-primary) 28%,
      transparent
    );
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 10%,
      var(--smrt-color-surface)
    );
  }

  .workspace-main {
    display: grid;
    gap: 1rem;
  }

  .callout-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }

  .callout-card,
  .panel {
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 95%,
      transparent
    );
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
    border-radius: 1rem;
  }

  .callout-card {
    padding: 1rem 1.1rem;
    display: grid;
    gap: 0.3rem;
  }

  .callout-card strong {
    font-size: 1.8rem;
  }

  .callout-card span {
    color: var(--smrt-color-on-surface-variant);
  }

  .panel {
    padding: 1rem;
  }

  .panel--error {
    display: grid;
    gap: 0.75rem;
  }

  .workspace-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }

  .secondary-action {
    border: 1px solid color-mix(
      in srgb,
      var(--smrt-color-primary) 30%,
      transparent
    );
    background: transparent;
    color: var(--smrt-color-primary);
    padding: 0.65rem 0.95rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-weight: 600;
    cursor: pointer;
  }

  .inline-link {
    color: var(--smrt-color-primary);
    text-decoration: none;
    font-weight: 600;
  }

  .inline-link:hover,
  .workspace-nav a:hover {
    text-decoration: underline;
  }
</style>
