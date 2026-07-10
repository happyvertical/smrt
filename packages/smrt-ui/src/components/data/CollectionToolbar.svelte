<script lang="ts">
import type { Snippet } from 'svelte';
import Input from '../forms/Input.svelte';
import SegmentedControl from '../forms/SegmentedControl.svelte';

export interface Props {
  search?: string;
  searchLabel?: string;
  searchPlaceholder?: string;
  view?: 'list' | 'grid' | 'table';
  views?: Array<'list' | 'grid' | 'table'>;
  resultCount?: number;
  selectedCount?: number;
  filters?: Snippet;
  actions?: Snippet;
  bulkActions?: Snippet;
  onsearchchange?: (value: string) => void;
  onviewchange?: (view: 'list' | 'grid' | 'table') => void;
  class?: string;
}

let {
  search = $bindable(''),
  searchLabel = 'Search',
  searchPlaceholder = 'Search…',
  view = $bindable('list'),
  views = ['list', 'grid'],
  resultCount,
  selectedCount = 0,
  filters,
  actions,
  bulkActions,
  onsearchchange,
  onviewchange,
  class: className = '',
}: Props = $props();

const viewOptions = $derived(
  views.map((value) => ({
    value,
    label: value[0].toUpperCase() + value.slice(1),
  })),
);

function changeView(next: string | number) {
  view = String(next) as typeof view;
  onviewchange?.(view);
}
</script>

<div class="toolbar {className}" role="search">
  <div class="search">
    <Input type="search" name="collection-search" aria-label={searchLabel} placeholder={searchPlaceholder} bind:value={search} oninput={(event) => onsearchchange?.(event.currentTarget.value)} />
  </div>
  {#if filters}<div class="filters">{@render filters()}</div>{/if}
  {#if resultCount !== undefined}<span class="count" aria-live="polite">{resultCount} {resultCount === 1 ? 'result' : 'results'}</span>{/if}
  <span class="spacer"></span>
  {#if selectedCount > 0 && bulkActions}<div class="bulk"><span>{selectedCount} selected</span>{@render bulkActions()}</div>{/if}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
  {#if viewOptions.length > 1}
    <SegmentedControl label="View" options={viewOptions} value={view} interaction={false} onvaluechange={changeView} />
  {/if}
</div>

<style>
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-2) 0; color: var(--smrt-color-on-surface); }
  .search { flex: 1 1 14rem; max-width: 24rem; }
  .filters, .actions, .bulk { display: flex; align-items: center; gap: var(--smrt-spacing-2); }
  .bulk { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border-radius: var(--smrt-radius-small); background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); }
  .count { color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-label-medium-font); }
  .spacer { flex: 1; }
</style>
