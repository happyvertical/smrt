<!--
  ListSortSelect — a "Sort by" picker for lists without column headers
  (card lists, and tables that turn into cards on phones).

  One option per column and direction, in plain words: dates read
  "newest first / oldest first", numbers "highest first / lowest first",
  text "A–Z / Z–A". Calls `onChange` with the chosen sort; server-sorted lists
  navigate to `listSortHref(...)` there.
-->
<script lang="ts">
import type {
  ListSort,
  ListSortDirection,
  ListSortSelectColumn,
} from './list-sort.js';
import type { ListSortState } from './list-sort-state.svelte.js';

interface Props {
  columns: readonly ListSortSelectColumn[];
  /** The list's sort state; supplies `sort` and `onChange`. */
  list?: ListSortState;
  sort?: ListSort;
  onChange?: (sort: ListSort) => void;
  label?: string;
  id?: string;
  class?: string;
}

let {
  columns,
  list,
  sort: sortProp,
  onChange: onChangeProp,
  label = 'Sort by',
  id = `list-sort-${Math.random().toString(36).slice(2, 9)}`,
  class: className = '',
}: Props = $props();

function directionWords(
  kind: ListSortSelectColumn['kind'],
  direction: ListSortDirection,
): string {
  if (kind === 'date')
    return direction === 'desc' ? 'newest first' : 'oldest first';
  if (kind === 'number')
    return direction === 'desc' ? 'highest first' : 'lowest first';
  return direction === 'asc' ? 'A–Z' : 'Z–A';
}

const sort = $derived<ListSort>(
  list?.sort ??
    sortProp ?? { columnId: columns[0]?.id ?? '', direction: 'desc' },
);
const onChange = (next: ListSort) => {
  if (list) void list.set(next);
  else onChangeProp?.(next);
};

const options = $derived(
  columns.flatMap((column) => {
    const order: ListSortDirection[] =
      column.kind === 'date' || column.kind === 'number'
        ? ['desc', 'asc']
        : ['asc', 'desc'];
    return order.map((direction) => ({
      value: `${column.id}:${direction}`,
      label: `${column.label}, ${directionWords(column.kind, direction)}`,
    }));
  }),
);

function handleChange(event: Event) {
  const value = (event.currentTarget as HTMLSelectElement).value;
  const separator = value.lastIndexOf(':');
  const direction = value.slice(separator + 1);
  if (direction !== 'asc' && direction !== 'desc') return;
  onChange({ columnId: value.slice(0, separator), direction });
}
</script>

<div class={`list-sort-select ${className}`}>
  <label class="list-sort-select__label" for={id}>{label}</label>
  <select
    {id}
    class="list-sort-select__control"
    value={`${sort.columnId}:${sort.direction}`}
    onchange={handleChange}
  >
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
</div>

<style>
  .list-sort-select {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .list-sort-select__label {
    font-size: 0.875rem;
    color: var(--color-text-secondary, inherit);
    white-space: nowrap;
  }
  .list-sort-select__control {
    min-height: 2.75rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-border, currentColor);
    border-radius: var(--radius-md, 0.375rem);
    background: var(--color-surface, transparent);
    color: inherit;
    font: inherit;
  }
</style>
