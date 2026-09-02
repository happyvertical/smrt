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
  /** Display layout: list (single column) or grid (multiple columns). */
  layout?: 'list' | 'grid';
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
  <div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading…</div>
{:else if items.length === 0}
  <div class="empty">{#if empty}{@render empty()}{:else}No items available{/if}</div>
{:else}
  <ul class="collection collection--{layout} {className}">
    {#each items as entry, index (keyOf(entry, index))}
      {@const key = keyOf(entry, index)}
      {@const isSelected = selected.has(key)}
      {@const itemTitle = textOf(entry, title) ?? `Item ${index + 1}`}
      <li class:selected={isSelected}>
        {#if selectable}<input type="checkbox" checked={isSelected} aria-label={`Select ${itemTitle}`} onchange={() => toggle(key)} />{/if}
        {#if onitemclick}
          <button type="button" class="main" onclick={() => onitemclick?.(entry, index)}>
            {#if item}{@render item({ item: entry, index, selected: isSelected })}{:else}<strong>{itemTitle}</strong>{#if description}<span>{textOf(entry, description)}</span>{/if}{/if}
          </button>
        {:else}
          <div class="main">
            {#if item}{@render item({ item: entry, index, selected: isSelected })}{:else}<strong>{itemTitle}</strong>{#if description}<span>{textOf(entry, description)}</span>{/if}{/if}
          </div>
        {/if}
        {#if actions}<div class="actions">{@render actions({ item: entry, index })}</div>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .collection { display: grid; gap: var(--smrt-spacing-2); margin: 0; padding: 0; list-style: none; }
  .collection--grid { grid-template-columns: repeat(auto-fill, minmax(min(18rem, 100%), 1fr)); }
  li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--smrt-spacing-3); min-width: 0; padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); }
  li.selected { border-color: var(--smrt-color-primary); background: var(--smrt-color-primary-container); }
  input { width: 1.125rem; height: 1.125rem; accent-color: var(--smrt-color-primary); }
  .main { display: grid; min-width: 0; gap: var(--smrt-spacing-1); padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
  button.main { width: 100%; cursor: pointer; }
  button.main:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 3px; }
  .main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--smrt-typography-title-small-font); }
  .main span { color: var(--smrt-color-on-surface-variant); }
  .actions { display: flex; gap: var(--smrt-spacing-1); }
  .loading, .empty { display: flex; min-height: 8rem; align-items: center; justify-content: center; gap: var(--smrt-spacing-2); color: var(--smrt-color-on-surface-variant); }
  .spinner { width: 1rem; height: 1rem; border: 2px solid var(--smrt-color-outline-variant); border-top-color: var(--smrt-color-primary); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 1.6s; } }
</style>
