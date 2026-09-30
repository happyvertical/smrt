<!--
  SortableHeader — a sortable column header for a hand-rolled table.

  Renders the `<th>` itself so `aria-sort` sits on the column header. The
  control inside is a link when `href` is given (server-sorted lists keep the
  sort in the URL; build it with `listSortHref`) or a button calling `onSort`
  (client-sorted lists; compute the next sort with `toggleListSort`). Both are
  reachable by Tab and activated with Enter (a button also with Space). The
  indicator shows ↑/↓ on the sorted column and a faint ↕ on the others.

  Use `as="div"` with `role="columnheader"` semantics for grid layouts that
  are not a `<table>`.
-->
<script lang="ts">
import type { Snippet } from 'svelte';
import {
  type ListSort,
  type ListSortSpec,
  listSortActionLabel,
  listSortAria,
} from './list-sort.js';

interface Props {
  columnId: string;
  label: string;
  /** Current sort of the list. */
  sort: ListSort | null | undefined;
  /** Link to the list sorted by this column (server-sorted lists). */
  href?: string;
  /** Called on activation (client-sorted lists). */
  onSort?: (columnId: string) => void;
  /** The list's sort spec; gives the column's first direction for the label. */
  spec?: ListSortSpec;
  as?: 'th' | 'div';
  align?: 'start' | 'center' | 'end';
  class?: string;
  children?: Snippet;
}

let {
  columnId,
  label,
  sort,
  href,
  onSort,
  spec,
  as = 'th',
  align = 'start',
  class: className = '',
  children,
}: Props = $props();

const aria = $derived(listSortAria(sort, columnId));
const active = $derived(aria !== 'none');
const actionLabel = $derived(listSortActionLabel(sort, columnId, label, spec));
</script>

{#snippet content()}
  <span class="sortable-header__label">
    {#if children}{@render children()}{:else}{label}{/if}
  </span>
  <span class="sortable-header__icon" class:is-active={active} aria-hidden="true">
    {#if aria === 'ascending'}↑{:else if aria === 'descending'}↓{:else}↕{/if}
  </span>
{/snippet}

<svelte:element
  this={as}
  class={`sortable-header sortable-header--${align} ${className}`}
  class:is-sorted={active}
  scope={as === 'th' ? 'col' : undefined}
  role={as === 'div' ? 'columnheader' : undefined}
  aria-sort={aria}
  data-sort-column={columnId}
>
  {#if href}
    <a
      class="sortable-header__control"
      {href}
      aria-label={actionLabel}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
      data-sveltekit-replacestate
      onclick={() => onSort?.(columnId)}
    >
      {@render content()}
    </a>
  {:else}
    <button
      type="button"
      class="sortable-header__control"
      aria-label={actionLabel}
      onclick={() => onSort?.(columnId)}
    >
      {@render content()}
    </button>
  {/if}
</svelte:element>

<style>
  .sortable-header {
    padding: 0;
    font-weight: inherit;
    text-align: start;
  }
  .sortable-header--center {
    text-align: center;
  }
  .sortable-header--end {
    text-align: end;
  }
  .sortable-header__control {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 2.75rem;
    width: 100%;
    padding: var(--sortable-header-padding, 0.5rem 0.75rem);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    text-align: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .sortable-header--center .sortable-header__control {
    justify-content: center;
  }
  .sortable-header--end .sortable-header__control {
    justify-content: flex-end;
  }
  .sortable-header__control:hover .sortable-header__label {
    text-decoration: underline;
  }
  .sortable-header__control:focus-visible {
    outline: 2px solid var(--color-focus, var(--color-primary, currentColor));
    outline-offset: -2px;
  }
  .sortable-header__icon {
    opacity: 0.35;
    font-size: 0.85em;
  }
  .sortable-header__icon.is-active {
    opacity: 1;
  }
</style>
