<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-svelte/themes';
import { onMount } from 'svelte';
import { createClient } from '../../mock-smrt-client';
import ContentEditor from '../../svelte/components/ContentEditor.svelte';
import ContentList from '../../svelte/components/ContentList.svelte';
import GovernedContentEditor from '../../svelte/components/GovernedContentEditor.svelte';

const client = createClient('/api/v1');

let contents = $state<any[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let showAddForm = $state(false);
let editingContent = $state<any>(null);
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

async function handleSaveContent(formData: any) {
  try {
    if (editingContent?.id) {
      const response = await client.contents.update(
        editingContent.id,
        formData,
      );
      const index = contents.findIndex(
        (content) => content.id === editingContent.id,
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

async function handleDeleteContent(content: any) {
  try {
    await client.contents.delete(content.id);
    contents = contents.filter((item) => item.id !== content.id);
  } catch (err: any) {
    error = err.message || 'Failed to delete content.';
  }
}

async function handleEditContent(content: any) {
  try {
    const response = await client.contents.get(content.id);
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

function getPublishedHref(content: any) {
  if (content?.status !== 'published' || !content?.slug) {
    return null;
  }

  return `/articles/${content.slug}`;
}
</script>

<ThemeProvider colorScheme="system" persist={true}>
  <div class="workspace-shell">
    <header class="workspace-header">
      <div class="workspace-header__copy">
        <div class="eyebrow">Reference QA Surface</div>
        <h1>Contents</h1>
        <p>
          Exercise governed authoring, publishing, and article review flows
          against the local content package API routes.
        </p>
      </div>

      <nav class="workspace-nav" aria-label="Content QA navigation">
        <a aria-current="page" href="/workspace">Workspace</a>
        <a href="/governance">Governance QA</a>
        <a href="/contributions">Contribution QA</a>
      </nav>
    </header>

    <main class="workspace-main">
      <section class="callout-grid">
        <article class="callout-card">
          <strong>{stats.total}</strong>
          <span>Total content records</span>
        </article>
        <article class="callout-card">
          <strong>{stats.published}</strong>
          <span>Published articles</span>
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
        </section>
      {:else}
        <section class="panel">
          <ContentList
            {contents}
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
                  Add governed article
                </button>
                <a class="inline-link" href="/governance">Review governance setup</a>
              </div>
            {/snippet}
          </ContentList>
        </section>
      {/if}
    </main>
  </div>
</ThemeProvider>

<style>
  :global(body) {
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
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: 600;
    opacity: 0.85;
  }

  .workspace-nav a[aria-current='page'] {
    opacity: 1;
    color: var(--smrt-color-primary);
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
    border: 1px solid color-mix(in srgb, var(--smrt-color-primary) 30%, transparent);
    background: transparent;
    color: var(--smrt-color-primary);
    padding: 0.65rem 0.95rem;
    border-radius: 999px;
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
