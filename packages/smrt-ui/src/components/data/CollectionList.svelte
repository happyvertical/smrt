<script lang="ts" generics="T">
import type { Snippet } from 'svelte';

export interface Props<T> {
  /** Array of items to display in the list or grid. */
  items: T[];
  /** Field name or function to uniquely identify each item. */
  itemKey?: keyof T | ((item: T) => string | number);
  /** Field name or function to extract the title text for each item. */
  title?: keyof T | ((item: T) => string);
  /** Field name or function to extract the description text for each item. */
  description?: keyof T | ((item: T) => string | undefined);
  /**
   * Display layout: list (single column of cards), divided (a flat single
   * column: no card surface, rows separated by a hairline, a selected row shown
   * by its checkbox), grid (multiple columns of cards), or gallery
   * (picture-first tiles: the `item` snippet fills the tile, the selection
   * checkbox and `actions` float over its top corners).
   */
  layout?: 'list' | 'divided' | 'grid' | 'gallery';
  /** Whether to show checkboxes for selecting multiple items. */
  selectable?: boolean;
  /** Set of currently selected item keys (bindable). */
  selected?: Set<string | number>;
  /** Whether to show a loading spinner instead of the collection. */
  loading?: boolean;
  /** Custom snippet to render each item's content. */
  item?: Snippet<[{ item: T; index: number; selected: boolean }]>;
  /** Custom snippet to render action buttons for each item. */
  actions?: Snippet<[{ item: T; index: number }]>;
  /** Custom snippet to render when there are no items. */
  empty?: Snippet;
  /** Callback when the selection set changes. */
  onselectionchange?: (selected: Set<string | number>) => void;
  /** Callback when an item is clicked. */
  onitemclick?: (item: T, index: number) => void;
  /** CSS class to apply to the collection container. */
  class?: string;
}

let {
  items,
  itemKey,
  title,
  description,
  layout = 'list',
  selectable = false,
  selected = $bindable(new Set<string | number>()),
  loading = false,
  item,
  actions,
  empty,
  onselectionchange,
  onitemclick,
  class: className = '',
}: Props<T> = $props();

function keyOf(entry: T, index: number): string | number {
  if (!itemKey) return index;
  return typeof itemKey === 'function'
    ? itemKey(entry)
    : (entry[itemKey] as string | number);
}

function textOf(
  entry: T,
  accessor: keyof T | ((item: T) => string | undefined) | undefined,
): string | undefined {
  if (!accessor) return undefined;
  return typeof accessor === 'function'
    ? accessor(entry)
    : String(entry[accessor] ?? '');
}

function toggle(key: string | number) {
  const next = new Set(selected);
  next.has(key) ? next.delete(key) : next.add(key);
  selected = next;
  onselectionchange?.(next);
}
</script>

{#if loading}
  <div class="smrt-collection-list__status" role="status" data-smrt-component="CollectionList"><span class="smrt-collection-list__spinner" data-smrt-part="spinner" aria-hidden="true"></span>Loading…</div>
{:else if items.length === 0}
  <div class="smrt-collection-list__empty" data-smrt-component="CollectionList">{#if empty}{@render empty()}{:else}No items available{/if}</div>
{:else}
  <ul class="smrt-collection-list__root smrt-collection-list__{layout} {className}" data-smrt-component="CollectionList">
    {#each items as entry, index (keyOf(entry, index))}
      {@const key = keyOf(entry, index)}
      {@const isSelected = selected.has(key)}
      {@const itemTitle = textOf(entry, title) ?? `Item ${index + 1}`}
      <li class:smrt-collection-list__selected={isSelected} data-smrt-part="item">
        {#if selectable}<label class="smrt-collection-list__select" data-smrt-part="control"><input type="checkbox" checked={isSelected} aria-label={`Select ${itemTitle}`} onchange={() => toggle(key)} /></label>{/if}
        {#if onitemclick}
          <button type="button" class="smrt-collection-list__main" data-smrt-part="body" onclick={() => onitemclick?.(entry, index)}>
            {#if item}{@render item({ item: entry, index, selected: isSelected })}{:else}<strong>{itemTitle}</strong>{#if description}<span>{textOf(entry, description)}</span>{/if}{/if}
          </button>
        {:else}
          <div class="smrt-collection-list__main" data-smrt-part="body">
            {#if item}{@render item({ item: entry, index, selected: isSelected })}{:else}<strong>{itemTitle}</strong>{#if description}<span>{textOf(entry, description)}</span>{/if}{/if}
          </div>
        {/if}
        {#if actions}<div class="smrt-collection-list__actions" data-smrt-part="actions">{@render actions({ item: entry, index })}</div>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-collection-list__root {
    display: grid;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-collection-list__grid {
    grid-template-columns: repeat(auto-fill, minmax(min(18rem, 100%), 1fr));
  }
  li {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--smrt-spacing-3);
    min-width: 0;
    padding: var(--smrt-spacing-3);
  }
  /* The selection box and actions sit above an item's stretched link. */
  .smrt-collection-list__select {
    position: relative;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.75rem;
    min-height: 2.75rem;
  }
  input {
    width: 1.125rem;
    height: 1.125rem;
  }
  .smrt-collection-list__main {
    display: grid;
    min-width: 0;
    gap: var(--smrt-spacing-1);
    padding: 0;
  }
  button.smrt-collection-list__main {
    width: 100%;
    cursor: pointer;
  }
  .smrt-collection-list__main strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-collection-list__actions {
    position: relative;
    z-index: 1;
    display: flex;
    gap: var(--smrt-spacing-1);
  }
  .smrt-collection-list__divided {
    gap: 0;
  }
  .smrt-collection-list__divided li {
    padding-inline: 0;
  }
  .smrt-collection-list__gallery {
    grid-template-columns: repeat(auto-fill, minmax(min(11rem, 100%), 1fr));
  }
  .smrt-collection-list__gallery li {
    display: block;
    padding: 0;
  }
  .smrt-collection-list__gallery .smrt-collection-list__main {
    gap: 0;
  }
  .smrt-collection-list__gallery .smrt-collection-list__select, .smrt-collection-list__gallery .smrt-collection-list__actions {
    position: absolute;
    top: var(--smrt-spacing-1);
    z-index: 2;
    min-width: 2.75rem;
    min-height: 2.75rem;
    align-items: center;
    justify-content: center;
  }
  .smrt-collection-list__gallery .smrt-collection-list__select {
    left: var(--smrt-spacing-1);
  }
  .smrt-collection-list__gallery .smrt-collection-list__actions {
    right: var(--smrt-spacing-1);
  }
  .smrt-collection-list__status, .smrt-collection-list__empty {
    display: flex;
    min-height: 8rem;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2);
  }
  .smrt-collection-list__spinner {
    width: 1rem;
    height: 1rem;
  }
}

@layer smrt.theme {
  li {
    border: var(--smrt-card-border, var(--smrt-hairline));
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-card-background, var(--smrt-color-surface));
    color: var(--smrt-color-on-surface);
  }
  li.smrt-collection-list__selected {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }
  input {
    accent-color: var(--smrt-color-primary);
  }
  .smrt-collection-list__main {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  button.smrt-collection-list__main:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-collection-list__main strong {
    font: var(--smrt-typography-title-small-font);
  }
  .smrt-collection-list__main span {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-collection-list__divided {
    --smrt-collection-list-divider: color-mix(in srgb, var(--smrt-color-outline-variant) 55%, transparent);
  }
  .smrt-collection-list__divided li {
    border: none;
    border-radius: 0;
    background: transparent;
  }
  .smrt-collection-list__divided li + li {
    border-block-start: 1px solid var(--smrt-collection-list-divider);
  }
  .smrt-collection-list__divided li.smrt-collection-list__selected {
    border-color: var(--smrt-collection-list-divider);
    background: transparent;
  }
  .smrt-collection-list__gallery .smrt-collection-list__select, .smrt-collection-list__gallery .smrt-collection-list__actions {
    border-radius: var(--smrt-radius-full);
    background: color-mix(in srgb, var(--smrt-color-surface) 82%, transparent);
  }
  .smrt-collection-list__status, .smrt-collection-list__empty {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-collection-list__spinner {
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-collection-list__spinner {
      animation-duration: 1.6s;
    }
  }
}

</style>
