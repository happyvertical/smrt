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

<div class="workbench">
  <header><p class="eyebrow">Reusable content pattern</p><h4>Collection list and toolbar</h4><p>Search, switch between list and grid views, select items, and use item actions across empty and loading states.</p></header>
  <CollectionToolbar bind:search bind:view resultCount={filtered.length} selectedCount={selected.size} onsearchchange={(value) => search = value}>
    {#snippet actions()}<Button size="sm">New article</Button>{/snippet}
    {#snippet bulkActions()}<Button size="sm" variant="ghost" onclick={() => selected = new Set()}>Clear</Button>{/snippet}
  </CollectionToolbar>
  <CollectionList items={filtered} itemKey="id" title="title" description="description" layout={view === 'grid' ? 'grid' : 'list'} selectable bind:selected>
    {#snippet actions({ item })}<span class="status">{item.status}</span><Button size="sm" variant="ghost">Open</Button>{/snippet}
    {#snippet empty()}<div><strong>No matching content</strong><p>Try a broader search.</p></div>{/snippet}
  </CollectionList>
</div>

<style>
  .workbench { display: grid; gap: var(--smrt-spacing-4); color: var(--smrt-color-on-surface); }
  header { padding-bottom: var(--smrt-spacing-4); border-bottom: 1px solid var(--smrt-color-outline-variant); } h4, p { margin: 0; } h4 { font: var(--smrt-typography-headline-small-font); } header > p:last-child { max-width: 48rem; margin-top: var(--smrt-spacing-1); color: var(--smrt-color-on-surface-variant); }
  .eyebrow { color: var(--smrt-color-primary); font: var(--smrt-typography-label-small-font); letter-spacing: .1em; text-transform: uppercase; }
  .status { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border-radius: var(--smrt-radius-full); background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); font: var(--smrt-typography-label-small-font); }
</style>
