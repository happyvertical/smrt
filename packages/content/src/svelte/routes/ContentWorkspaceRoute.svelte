<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import type { ContentData } from '../../mock-smrt-client.js';
import { createClient } from '../../mock-smrt-client.js';
import ContentEditor from '../components/ContentEditor.svelte';
import ContentList from '../components/ContentList.svelte';
import GovernedContentEditor from '../components/GovernedContentEditor.svelte';
import { M } from '../i18n.routes.js';
import {
  buildPublishedArticlePath,
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
  getContentRouteHref,
} from './shared.js';

interface ContentWorkspaceRouteProps {
  /** Pre-initialized API client; creates a new one if omitted. */
  client?: ReturnType<typeof createClient>;
  /** Navigation items shown in the sidebar. */
  navigation?: ContentRouteNavigationItem[];
  /** Base URL for content API requests. */
  apiBaseUrl?: string;
  /** Returns a URL to view published content; null hides the view link. */
  getPublishedHref?: (content: ContentData) => string | null;
  /** Whether the route is embedded in a parent application. */
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
  client = undefined,
}: ContentWorkspaceRouteProps = $props();

const apiClient = $derived(client ?? createClient(apiBaseUrl));
const governanceHref = $derived(
  getContentRouteHref(navigation, CONTENT_ROUTE_IDS.governance),
);
const { t } = useI18n();

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
    const response = await apiClient.contents.list();
    contents = response.data;
    error = null;
  } catch (err) {
    error =
      (err instanceof Error ? err.message : '') || 'Failed to load contents.';
  } finally {
    loading = false;
  }
}

async function handleSaveContent(formData: ContentData) {
  try {
    const currentEditingContent = editingContent;
    if (currentEditingContent?.id) {
      const response = await apiClient.contents.update(
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
      const response = await apiClient.contents.create(formData);
      contents = [response.data, ...contents];
    }

    closeForms();
  } catch (err) {
    error =
      (err instanceof Error ? err.message : '') || 'Failed to save content.';
  }
}

async function handleDeleteContent(content: ContentData) {
  try {
    await apiClient.contents.delete(content.id || '');
    contents = contents.filter((item) => item.id !== content.id);
  } catch (err) {
    error =
      (err instanceof Error ? err.message : '') || 'Failed to delete content.';
  }
}

async function handleEditContent(content: ContentData) {
  try {
    const response = await apiClient.contents.get(content.id || '');
    editingContent = response.data;
    const governance = await apiClient.contents.resolveGovernance({
      type: response.data.type,
      variant: response.data.variant,
    });
    editorMode = governance.data.isGoverned ? 'governed' : 'generic';
  } catch (err) {
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

<div class="smrt-content-workspace-route__root" class:smrt-content-workspace-route__root--embedded={embedded} data-smrt-component="ContentWorkspaceRoute">
  <header class="smrt-content-workspace-route__header" data-smrt-part="header">
    <div class="smrt-content-workspace-route__copy" data-smrt-part="body">
      <div class="smrt-content-workspace-route__eyebrow" data-smrt-part="label">{t(M['content.workspace.eyebrow'])}</div>
      <h1>{t(M['content.workspace.heading'])}</h1>
      <p>
        {t(M['content.workspace.intro'])}
      </p>
    </div>

    <nav class="smrt-content-workspace-route__nav" data-smrt-part="nav" aria-label={t(M['content.workspace.nav_aria'])}>
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

  <main class="smrt-content-workspace-route__main" data-smrt-part="body">
    <section class="smrt-content-workspace-route__callout-grid" data-smrt-part="grid">
      <article class="smrt-content-workspace-route__callout-card" data-smrt-part="status">
        <strong>{stats.total}</strong>
        <span>{t(M['content.workspace.stat_total'])}</span>
      </article>
      <article class="smrt-content-workspace-route__callout-card" data-smrt-part="status">
        <strong>{stats.published}</strong>
        <span>{t(M['content.workspace.stat_published'])}</span>
      </article>
    </section>

    {#if loading}
      <section class="smrt-content-workspace-route__panel" data-smrt-part="panel">
        <p>{t(M['content.workspace.loading'])}</p>
      </section>
    {:else if error}
      <section class="smrt-content-workspace-route__panel smrt-content-workspace-route__panel--error" data-smrt-part="panel">
        <p><strong>Error:</strong> {error}</p>
        <Button variant="secondary" type="button" onclick={loadContents}>{t(M['content.workspace.try_again'])}</Button>
      </section>
    {:else if showAddForm || editingContent}
      <section class="smrt-content-workspace-route__panel" data-smrt-part="panel">
        {#if editorMode === 'governed'}
          <GovernedContentEditor
            {apiBaseUrl}
            content={editingContent || undefined}
            contentId={editingContent?.id || 'new'}
            agentChatEnabled={!embedded}
            agentChatNotice="Run the content package dev server to use live editor agent chat from this route."
            showGovernancePanel={!embedded}
            onSave={handleSaveContent}
            onCancel={closeForms}
          />
        {:else}
          <ContentEditor
            {apiBaseUrl}
            content={editingContent || undefined}
            contentId={editingContent?.id || 'new'}
            agentChatEnabled={!embedded}
            agentChatNotice="Run the content package dev server to use live editor agent chat from this route."
            onSave={handleSaveContent}
            onCancel={closeForms}
          />
        {/if}
      </section>
    {:else}
      <section class="smrt-content-workspace-route__panel" data-smrt-part="panel">
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
            <div class="smrt-content-workspace-route__controls" data-smrt-part="actions">
              <Button
                variant="ghost"
                type="button"
                class="secondary-action"
                onclick={handleAddGovernedContent}
              >
                {t(M['content.workspace.create_governed'])}
              </Button>
              <a class="smrt-content-workspace-route__inline-link" data-smrt-part="action" href={governanceHref}>
                {t(M['content.workspace.review_governance'])}
              </a>
            </div>
          {/snippet}
        </ContentList>
      </section>
    {/if}
  </main>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  :global(body:has(.smrt-content-workspace-route__root:not(.smrt-content-workspace-route__root--embedded))) {
    margin: 0;
    min-height: 100vh;
  }
  .smrt-content-workspace-route__root {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
    display: grid;
    gap: 1.5rem;
    max-width: 1280px;
    margin: 0 auto;
  }
  .smrt-content-workspace-route__root--embedded {
    min-height: auto;
    padding: 0;
    max-width: none;
  }
  .smrt-content-workspace-route__header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .smrt-content-workspace-route__copy {
    max-width: 44rem;
  }
  .smrt-content-workspace-route__header h1 {
    margin: 0.35rem 0 0.65rem;
  }
  .smrt-content-workspace-route__header p {
    margin: 0;
    max-width: 38rem;
  }
  .smrt-content-workspace-route__nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .smrt-content-workspace-route__nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
  }
  .smrt-content-workspace-route__main {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-workspace-route__callout-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }
  .smrt-content-workspace-route__callout-card {
    padding: 1rem 1.1rem;
    display: grid;
    gap: 0.3rem;
  }
  .smrt-content-workspace-route__panel {
    padding: 1rem;
  }
  .smrt-content-workspace-route__panel--error {
    display: grid;
    gap: 0.75rem;
  }
  .smrt-content-workspace-route__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }
  .smrt-content-workspace-route__controls :global(.secondary-action) {
    padding: 0.65rem 0.95rem;
    cursor: pointer;
  }
}

@layer smrt.theme {
  :global(body:has(.smrt-content-workspace-route__root:not(.smrt-content-workspace-route__root--embedded))) {
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
  }
  .smrt-content-workspace-route__eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-content-workspace-route__header h1 {
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }
  .smrt-content-workspace-route__header p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-workspace-route__nav a {
    border-radius: var(--smrt-radius-full);
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-workspace-route__nav a[aria-current='page'] {
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
  .smrt-content-workspace-route__callout-card,
  .smrt-content-workspace-route__panel {
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 95%,
      transparent
    );
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
    border-radius: 1rem;
  }
  .smrt-content-workspace-route__callout-card strong {
    font-size: var(--smrt-typography-headline-medium-size, 1.8rem);
  }
  .smrt-content-workspace-route__callout-card span {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-workspace-route__controls :global(.secondary-action) {
    border: 1px solid color-mix(
      in srgb,
      var(--smrt-color-primary) 30%,
      transparent
    );
    background: transparent;
    color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-workspace-route__inline-link {
    color: var(--smrt-color-primary);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-workspace-route__inline-link:hover,
  .smrt-content-workspace-route__nav a:hover {
    text-decoration: underline;
  }
}

</style>
