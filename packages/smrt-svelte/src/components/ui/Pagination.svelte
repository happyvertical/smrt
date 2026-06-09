<script lang="ts">
/**
 * Pagination - Page navigation component
 *
 * Provides page navigation with first/prev/next/last controls.
 * Supports both link-based (SSR) and callback-based (client-side) modes.
 *
 * Accessibility:
 * - Proper ARIA labels on all controls
 * - aria-current marks current page
 * - Native list semantics for numbered pages
 */

/** Props for Pagination component */
export interface Props {
  /** Current active page (1-based) */
  currentPage: number;
  /** Total number of pages */
  totalPages: number;
  /** Base URL for link mode (e.g., '/articles') */
  baseUrl?: string;
  /** When provided, renders buttons instead of links and calls this on page change */
  onPageChange?: (page: number) => void;
  /** Accessible label for pagination nav */
  'aria-label'?: string;
  /** Show first/last page buttons */
  showFirstLast?: boolean;
  /** Maximum number of visible page numbers */
  maxVisible?: number;
}

const {
  currentPage,
  totalPages,
  baseUrl = '/articles',
  onPageChange,
  'aria-label': ariaLabel = 'Pagination',
  showFirstLast = true,
  maxVisible = 5,
}: Props = $props();

function getPageUrl(page: number): string {
  if (page === 1) return baseUrl || '/';
  return `${baseUrl}/page/${page}`;
}

// Generate array of page numbers to display
function getPageNumbers(): (number | 'ellipsis')[] {
  const pages: (number | 'ellipsis')[] = [];

  if (totalPages <= maxVisible + 2) {
    // Show all pages if there aren't many
    for (let i = 1; i <= totalPages; i++) {
      pages.push(i);
    }
  } else {
    // Always show first page
    pages.push(1);

    // Calculate range around current page
    let start = Math.max(2, currentPage - 1);
    let end = Math.min(totalPages - 1, currentPage + 1);

    // Adjust if at the start
    if (currentPage <= 3) {
      end = Math.min(totalPages - 1, maxVisible - 1);
    }

    // Adjust if at the end
    if (currentPage >= totalPages - 2) {
      start = Math.max(2, totalPages - maxVisible + 2);
    }

    // Add ellipsis before middle section if needed
    if (start > 2) {
      pages.push('ellipsis');
    }

    // Add middle pages
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    // Add ellipsis after middle section if needed
    if (end < totalPages - 1) {
      pages.push('ellipsis');
    }

    // Always show last page
    pages.push(totalPages);
  }

  return pages;
}

const pageNumbers = $derived(getPageNumbers());
const hasPrevPage = $derived(currentPage > 1);
const hasNextPage = $derived(currentPage < totalPages);
const isFirstPage = $derived(currentPage === 1);
const isLastPage = $derived(currentPage === totalPages);
</script>

{#if totalPages > 1}
  <nav class="pagination" aria-label={ariaLabel}>
    <!-- First page -->
    {#if showFirstLast}
      {#if onPageChange}
        <button class="page-link nav-link first" type="button" disabled={isFirstPage} onclick={() => onPageChange(1)} aria-label="First page">
          &laquo; First
        </button>
      {:else if !isFirstPage}
        <a href={getPageUrl(1)} class="page-link nav-link first" aria-label="First page">
          &laquo; First
        </a>
      {:else}
        <span class="page-link nav-link disabled first" aria-hidden="true">&laquo; First</span>
      {/if}
    {/if}

    <!-- Previous page -->
    {#if onPageChange}
      <button class="page-link nav-link" type="button" disabled={!hasPrevPage} onclick={() => onPageChange(currentPage - 1)} aria-label="Previous page">
        &larr; Prev
      </button>
    {:else if hasPrevPage}
      <a href={getPageUrl(currentPage - 1)} class="page-link nav-link" aria-label="Previous page">
        &larr; Prev
      </a>
    {:else}
      <span class="page-link nav-link disabled" aria-hidden="true">&larr; Prev</span>
    {/if}

    <ul class="page-numbers">
      {#each pageNumbers as page}
        {#if page === 'ellipsis'}
          <li class="page-numbers__item">
            <span class="ellipsis" aria-hidden="true">&hellip;</span>
          </li>
        {:else if page === currentPage}
          <li class="page-numbers__item">
            <span class="page-link current" aria-current="page" aria-label="Page {page}, current">{page}</span>
          </li>
        {:else if onPageChange}
          <li class="page-numbers__item">
            <button class="page-link" type="button" onclick={() => onPageChange(page as number)} aria-label="Go to page {page}">{page}</button>
          </li>
        {:else}
          <li class="page-numbers__item">
            <a href={getPageUrl(page)} class="page-link" aria-label="Go to page {page}">{page}</a>
          </li>
        {/if}
      {/each}
    </ul>

    <!-- Next page -->
    {#if onPageChange}
      <button class="page-link nav-link" type="button" disabled={!hasNextPage} onclick={() => onPageChange(currentPage + 1)} aria-label="Next page">
        Next &rarr;
      </button>
    {:else if hasNextPage}
      <a href={getPageUrl(currentPage + 1)} class="page-link nav-link" aria-label="Next page">
        Next &rarr;
      </a>
    {:else}
      <span class="page-link nav-link disabled" aria-hidden="true">Next &rarr;</span>
    {/if}

    <!-- Last page -->
    {#if showFirstLast}
      {#if onPageChange}
        <button class="page-link nav-link last" type="button" disabled={isLastPage} onclick={() => onPageChange(totalPages)} aria-label="Last page ({totalPages})">
          Last &raquo;
        </button>
      {:else if !isLastPage}
        <a href={getPageUrl(totalPages)} class="page-link nav-link last" aria-label="Last page ({totalPages})">
          Last &raquo;
        </a>
      {:else}
        <span class="page-link nav-link disabled last" aria-hidden="true">Last &raquo;</span>
      {/if}
    {/if}
  </nav>
{/if}

<style>
  .pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-8, 2rem);
    padding: var(--smrt-spacing-4, 1rem) 0;
    flex-wrap: wrap;
  }

  .page-numbers {
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin: 0;
    padding: 0;
  }

  .page-numbers__item {
    margin: 0;
    padding: 0;
  }

  .page-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    height: 2.25rem;
    padding: 0 var(--smrt-spacing-2, 0.5rem);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    text-decoration: none;
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease), color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .page-link:not(.current):not(.disabled) {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    color: var(--smrt-color-on-surface, #374151);
  }

  .page-link:not(.current):not(.disabled):hover {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, white);
  }

  .page-link.current {
    background: var(--smrt-color-primary, #005ac1);
    color: white;
    cursor: default;
  }

  .page-link.disabled,
  .page-link:disabled {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    color: var(--smrt-color-on-surface-variant, #9ca3af);
    cursor: not-allowed;
  }

  button.page-link {
    border: none;
    font: inherit;
    cursor: pointer;
  }

  .nav-link {
    padding: 0 var(--smrt-spacing-4, 1rem);
  }

  .nav-link.first,
  .nav-link.last {
    display: none;
  }

  @media (min-width: 640px) {
    .nav-link.first,
    .nav-link.last {
      display: inline-flex;
    }
  }

  .ellipsis {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    height: 2.25rem;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  @media (max-width: 480px) {
    .page-link {
      min-width: 2rem;
      height: 2rem;
      font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    }

    .nav-link {
      padding: 0 var(--smrt-spacing-2, 0.5rem);
    }
  }
</style>
