<script lang="ts">
import { onDestroy } from 'svelte';
/**
 * AssetToolbar - Filter bar and view controls for the Asset Manager
 *
 * Provides search, type/tag filtering, sort controls, view mode toggle,
 * and an upload button.
 */

import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from './i18n.js';
import type {
  AssetFilters,
  AssetSort,
  AssetSortField,
  AssetToolbarProps,
  AssetViewMode,
} from './types';

const { t } = useI18n();

let {
  view,
  filters,
  sort,
  onviewchange,
  onViewChange,
  onfilterchange,
  onFilterChange,
  onsortchange,
  onSortChange,
  onupload,
  onUpload,
}: AssetToolbarProps = $props();

function getInitialToolbarState() {
  return {
    searchValue: filters.search,
    filters,
  };
}

const initialToolbarState = getInitialToolbarState();
let searchValue = $state(initialToolbarState.searchValue);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let appliedFilters: AssetFilters | undefined = initialToolbarState.filters;

$effect(() => {
  if (appliedFilters === filters) {
    return;
  }

  appliedFilters = filters;
  searchValue = filters.search;
});

onDestroy(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});

function handleSearch(e: Event) {
  const target = e.target as HTMLInputElement;
  searchValue = target.value;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    (onfilterchange ?? onFilterChange)({ ...filters, search: searchValue });
  }, 300);
}

function handleClearSearch() {
  searchValue = '';
  (onfilterchange ?? onFilterChange)({ ...filters, search: '' });
}

function handleSortChange(e: Event) {
  const target = e.target as HTMLSelectElement;
  const [field, direction] = target.value.split(':') as [
    AssetSortField,
    'asc' | 'desc',
  ];
  (onsortchange ?? onSortChange)({ field, direction });
}

function handleTypeFilter(e: Event) {
  const target = e.target as HTMLSelectElement;
  const types = target.value ? [target.value] : [];
  (onfilterchange ?? onFilterChange)({ ...filters, types });
}

const sortValue = $derived(`${sort.field}:${sort.direction}`);
const typeValue = $derived(filters.types.length > 0 ? filters.types[0] : '');

const views: { key: AssetViewMode; label: string; icon: string }[] = [
  { key: 'grid', label: 'Grid', icon: 'grid' },
  { key: 'list', label: 'List', icon: 'list' },
];
</script>

<div class="smrt-asset-toolbar__root" data-smrt-component="AssetToolbar">
  <div class="smrt-asset-toolbar__left" data-smrt-part="group">
    <!-- Search -->
    <div class="smrt-asset-toolbar__search" data-smrt-part="field">
      <span class="smrt-asset-toolbar__search-icon" data-smrt-part="icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      </span>
      <Input
        type="search"
        placeholder={t(M['assets.asset_toolbar.search_placeholder'])}
        value={searchValue}
        oninput={handleSearch}
        aria-label={t(M['assets.asset_toolbar.search_assets'])}
      />
      {#if searchValue}
        <Button variant="ghost" size="sm" onclick={handleClearSearch} aria-label={t(M['assets.asset_toolbar.clear_search'])}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </Button>
      {/if}
    </div>

    <!-- Type Filter -->
    <Select value={typeValue} onchange={handleTypeFilter} aria-label={t(M['assets.asset_toolbar.filter_by_type'])}>
      <option value="">{t(M['assets.asset_toolbar.all_types'])}</option>
      <option value="image">Images</option>
      <option value="video">Videos</option>
      <option value="document">Documents</option>
      <option value="audio">Audio</option>
    </Select>

    <!-- Sort -->
    <Select value={sortValue} onchange={handleSortChange} aria-label={t(M['assets.asset_toolbar.sort_assets'])}>
      <option value="createdAt:desc">{t(M['assets.asset_toolbar.newest_first'])}</option>
      <option value="createdAt:asc">{t(M['assets.asset_toolbar.oldest_first'])}</option>
      <option value="name:asc">{t(M['assets.asset_toolbar.name_a_z'])}</option>
      <option value="name:desc">{t(M['assets.asset_toolbar.name_z_a'])}</option>
      <option value="updatedAt:desc">{t(M['assets.asset_toolbar.recently_updated'])}</option>
    </Select>
  </div>

  <div class="smrt-asset-toolbar__right" data-smrt-part="actions">
    <!-- View Toggle -->
    <div class="smrt-asset-toolbar__view-toggle" data-smrt-part="group" role="group" aria-label={t(M['assets.asset_toolbar.view_mode'])}>
      {#each views as v (v.key)}
        <Button
          variant={view === v.key ? 'primary' : 'ghost'}
          onclick={() => (onviewchange ?? onViewChange)(v.key)}
          aria-label={t(M['assets.asset_toolbar.view_label'], { label: v.label })}
          aria-pressed={view === v.key}
        >
          {#if v.icon === 'grid'}
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
            </svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"></line>
              <line x1="8" y1="12" x2="21" y2="12"></line>
              <line x1="8" y1="18" x2="21" y2="18"></line>
              <line x1="3" y1="6" x2="3.01" y2="6"></line>
              <line x1="3" y1="12" x2="3.01" y2="12"></line>
              <line x1="3" y1="18" x2="3.01" y2="18"></line>
            </svg>
          {/if}
        </Button>
      {/each}
    </div>

    <!-- Upload Button -->
    <Button
      variant="primary"
      onclick={() => (onupload ?? onUpload)()}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path>
        <polyline points="17 8 12 3 7 8"></polyline>
        <line x1="12" y1="3" x2="12" y2="15"></line>
      </svg>
      Upload
    </Button>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-asset-toolbar__root {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3, 0.75rem);
    padding: var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-4, 1rem);
    flex-wrap: wrap;
  }
  .smrt-asset-toolbar__left {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
  }
  .smrt-asset-toolbar__right {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    flex-shrink: 0;
  }
  /* Search */
  .smrt-asset-toolbar__search {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 180px;
    max-width: 320px;
    height: 36px;
  }
  .smrt-asset-toolbar__search-icon {
    display: flex;
    align-items: center;
    padding-left: var(--smrt-spacing-2, 0.5rem);
  }
  /* The search field renders via <Input> (issue #1589). It sits inside the
  bordered .smrt-asset-toolbar__search shell, so the overrides strip the
  primitive's own border/background/box-shadow to keep it transparent and
  reach the child <input> through :global() scoping. */
  .smrt-asset-toolbar__search :global([data-smrt-component="Input"]) {
    flex: 1;
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    min-width: 0;
  }
  .smrt-asset-toolbar__search :global([data-smrt-component="Input"]::-webkit-search-cancel-button) {
    display: none;
  }
  /* The clear control renders via <Button> (issue #1589). The overrides shape it
  into a small round icon button and reach the child <button> via :global()
  scoping. */
  .smrt-asset-toolbar__search :global([data-smrt-component="Button"]) {
    width: 24px;
    height: 24px;
    margin-right: var(--smrt-spacing-1, 0.25rem);
    padding: 0;
  }
  /* Selects render via <Select> (issue #1589). The base select primitive owns
  the chevron + focus ring; these overrides pin the toolbar-matching 36px
  height, container-low fill, and width, and reach the child <select> through
  :global() scoping. */
  .smrt-asset-toolbar__left :global([data-smrt-component="Select"]) {
    width: auto;
    height: 36px;
    padding: 0 var(--smrt-spacing-8, 2rem) 0 var(--smrt-spacing-3, 0.75rem);
    cursor: pointer;
  }
  /* View Toggle */
  .smrt-asset-toolbar__view-toggle {
    display: flex;
    overflow: hidden;
  }
  /* The toggle buttons render via <Button> (issue #1589); the active state is
  the `primary` variant, the inactive state the `ghost` variant. These overrides
  give the buttons their square icon footprint and the segmented divider, and
  reach the child <button> via :global() scoping. */
  .smrt-asset-toolbar__view-toggle :global([data-smrt-component="Button"]) {
    width: 36px;
    height: 36px;
    padding: 0;
  }
  /* Upload Button — renders via <Button variant="primary"> (issue #1589). The
  primary variant owns the fill/hover; the override only pins the
  toolbar-matching 36px height and gap, reaching the child <button> via
  :global() scoping. */
  .smrt-asset-toolbar__right > :global([data-smrt-component="Button"]) {
    gap: var(--smrt-spacing-1, 0.25rem);
    height: 36px;
    padding: 0 var(--smrt-spacing-3, 0.75rem);
  }
  @media (max-width: 640px) {
    .smrt-asset-toolbar__root {
      flex-direction: column;
      align-items: stretch;
    }
    .smrt-asset-toolbar__left {
      flex-direction: column;
    }
    .smrt-asset-toolbar__search {
      max-width: none;
    }
    .smrt-asset-toolbar__right {
      justify-content: space-between;
    }
  }
}

@layer smrt.theme {
  .smrt-asset-toolbar__root {
    background: var(--smrt-color-surface);
    border-bottom: var(--smrt-hairline);
  }
  /* Search */
  .smrt-asset-toolbar__search {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    transition: border-color 150ms ease;
  }
  .smrt-asset-toolbar__search:focus-within {
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 2px var(--smrt-color-primary-container, rgba(0, 90, 193, 0.1));
  }
  .smrt-asset-toolbar__search-icon {
    color: var(--smrt-color-on-surface-variant);
  }
  /* The search field renders via <Input> (issue #1589). It sits inside the
  bordered .smrt-asset-toolbar__search shell, so the overrides strip the
  primitive's own border/background/box-shadow to keep it transparent and
  reach the child <input> through :global() scoping. */
  .smrt-asset-toolbar__search :global([data-smrt-component="Input"]) {
    border: none;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
    outline: none;
  }
  .smrt-asset-toolbar__search :global([data-smrt-component="Input"]:focus) {
    border: none;
    box-shadow: none;
  }
  .smrt-asset-toolbar__search :global([data-smrt-component="Input"]::placeholder) {
    color: var(--smrt-color-on-surface-variant);
  }
  /* The clear control renders via <Button> (issue #1589). The overrides shape it
  into a small round icon button and reach the child <button> via :global()
  scoping. */
  .smrt-asset-toolbar__search :global([data-smrt-component="Button"]) {
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-asset-toolbar__search :global([data-smrt-component="Button"]:hover) {
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface-container);
  }
  /* Selects render via <Select> (issue #1589). The base select primitive owns
  the chevron + focus ring; these overrides pin the toolbar-matching 36px
  height, container-low fill, and width, and reach the child <select> through
  :global() scoping. */
  .smrt-asset-toolbar__left :global([data-smrt-component="Select"]) {
    background-color: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface);
  }
  /* View Toggle */
  .smrt-asset-toolbar__view-toggle {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }
  /* The toggle buttons render via <Button> (issue #1589); the active state is
  the `primary` variant, the inactive state the `ghost` variant. These overrides
  give the buttons their square icon footprint and the segmented divider, and
  reach the child <button> via :global() scoping. */
  .smrt-asset-toolbar__view-toggle :global([data-smrt-component="Button"]) {
    border: none;
    border-radius: 0;
  }
  .smrt-asset-toolbar__view-toggle :global([data-smrt-component="Button"]:not(:last-child)) {
    border-right: var(--smrt-hairline);
  }
  /* Upload Button — renders via <Button variant="primary"> (issue #1589). The
  primary variant owns the fill/hover; the override only pins the
  toolbar-matching 36px height and gap, reaching the child <button> via
  :global() scoping. */
  .smrt-asset-toolbar__right > :global([data-smrt-component="Button"]) {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
}

</style>
