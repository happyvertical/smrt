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
 * - Keyboard navigation supported
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

/**
 * Handle keyboard navigation
 */
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft' && hasPrevPage) {
    event.preventDefault();
    onPageChange?.(currentPage - 1);
  } else if (event.key === 'ArrowRight' && hasNextPage) {
    event.preventDefault();
    onPageChange?.(currentPage + 1);
  } else if (event.key === 'Home' && !isFirstPage) {
    event.preventDefault();
    onPageChange?.(1);
  } else if (event.key === 'End' && !isLastPage) {
    event.preventDefault();
    onPageChange?.(totalPages);
  }
}

const pageNumbers = $derived(getPageNumbers());
const hasPrevPage = $derived(currentPage > 1);
const hasNextPage = $derived(currentPage < totalPages);
const isFirstPage = $derived(currentPage === 1);
const isLastPage = $derived(currentPage === totalPages);
</script>

{#if totalPages > 1}
  <nav class="pagination" aria-label={ariaLabel} onkeydown={handleKeydown}>
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

    <div class="page-numbers" role="list">
      {#each pageNumbers as page}
        {#if page === 'ellipsis'}
          <span class="ellipsis" aria-hidden="true">&hellip;</span>
        {:else if page === currentPage}
          <span class="page-link current" role="listitem" aria-current="page" aria-label="Page {page}, current">{page}</span>
        {:else if onPageChange}
          <button class="page-link" type="button" role="listitem" onclick={() => onPageChange(page as number)} aria-label="Go to page {page}">{page}</button>
        {:else}
          <a href={getPageUrl(page)} class="page-link" role="listitem" aria-label="Go to page {page}">{page}</a>
        {/if}
      {/each}
    </div>

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
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
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
    font-weight: 500;
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
      font-size: 0.8125rem;
    }

    .nav-link {
      padding: 0 var(--smrt-spacing-2, 0.5rem);
    }
  }
</style>
