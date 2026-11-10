<script lang="ts">
import CollectionList from '../../components/data/CollectionList.svelte';
import CollectionToolbar from '../../components/data/CollectionToolbar.svelte';
import Button from '../../components/ui/Button.svelte';

interface Article {
  id: string;
  title: string;
  description: string;
  status: string;
}
const articles: Article[] = [
  {
    id: 'one',
    title: 'Agent-ready form controls',
    description: 'Stable identity and consent-aware updates.',
    status: 'Published',
  },
  {
    id: 'two',
    title: 'A complete interaction layer',
    description: 'Overlays, progress, menus, and disclosure.',
    status: 'Draft',
  },
  {
    id: 'three',
    title: 'Collection patterns',
    description: 'Lists and grids without application-specific markup.',
    status: 'Review',
  },
];
let search = $state('');
let view = $state<'list' | 'grid' | 'table'>('list');
let selected = $state<Set<string | number>>(new Set());
const filtered = $derived(
  articles.filter((article) =>
    article.title.toLowerCase().includes(search.toLowerCase()),
  ),
);
</script>

<div class="smrt-collections-preview__root" data-smrt-component="CollectionsPreview">
  <header><p class="smrt-collections-preview__eyebrow" data-smrt-part="label">Reusable content pattern</p><h4>Collection list and toolbar</h4><p>Search, switch between list and grid views, select items, and use item actions across empty and loading states.</p></header>
  <CollectionToolbar bind:search bind:view resultCount={filtered.length} selectedCount={selected.size} onsearchchange={(value) => search = value}>
    {#snippet actions()}<Button size="sm">New article</Button>{/snippet}
    {#snippet bulkActions()}<Button size="sm" variant="ghost" onclick={() => selected = new Set()}>Clear</Button>{/snippet}
  </CollectionToolbar>
  <CollectionList items={filtered} itemKey="id" title="title" description="description" layout={view === 'grid' ? 'grid' : 'list'} selectable bind:selected>
    {#snippet actions({ item })}<span class="smrt-collections-preview__status" data-smrt-part="status">{item.status}</span><Button size="sm" variant="ghost">Open</Button>{/snippet}
    {#snippet empty()}<div><strong>No matching content</strong><p>Try a broader search.</p></div>{/snippet}
  </CollectionList>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-collections-preview__root {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  header {
    padding-bottom: var(--smrt-spacing-4);
  }
  h4, p {
    margin: 0;
  }
  header > p:last-child {
    max-width: 48rem;
    margin-top: var(--smrt-spacing-1);
  }
  .smrt-collections-preview__status {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
}

@layer smrt.theme {
  .smrt-collections-preview__root {
    color: var(--smrt-color-on-surface);
  }
  header {
    border-bottom: var(--smrt-hairline);
  }
  h4 {
    font: var(--smrt-typography-headline-small-font);
  }
  header > p:last-child {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-collections-preview__eyebrow {
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-small-font);
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  .smrt-collections-preview__status {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    font: var(--smrt-typography-label-small-font);
  }
}

</style>
