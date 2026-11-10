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

import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';

const { t } = useI18n();

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
  /**
   * Control target density. `touch` raises every page and nav control to
   * `--smrt-touch-target-min`; omit to inherit the ThemeProvider setting
   * (`--smrt-control-target-min`).
   */
  density?: 'comfortable' | 'touch';
}

const {
  currentPage,
  totalPages,
  baseUrl = '/articles',
  onPageChange,
  'aria-label': ariaLabel = 'Pagination',
  showFirstLast = true,
  maxVisible = 5,
  density,
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
  <nav class="smrt-pagination__root" data-density={density} aria-label={ariaLabel} data-smrt-component="Pagination">
    <!-- First page -->
    {#if showFirstLast}
      {#if onPageChange}
        <button class="smrt-pagination__link smrt-pagination__nav smrt-pagination__first" data-smrt-part="item" type="button" disabled={isFirstPage} onclick={() => onPageChange(1)} aria-label={t(M['ui.pagination.first_page'])}>
          &laquo; First
        </button>
      {:else if !isFirstPage}
        <a href={getPageUrl(1)} class="smrt-pagination__link smrt-pagination__nav smrt-pagination__first" data-smrt-part="item" aria-label={t(M['ui.pagination.first_page'])}>
          &laquo; First
        </a>
      {:else}
        <span class="smrt-pagination__link smrt-pagination__nav smrt-pagination__disabled smrt-pagination__first" data-smrt-part="item" aria-hidden="true">&laquo; First</span>
      {/if}
    {/if}

    <!-- Previous page -->
    {#if onPageChange}
      <button class="smrt-pagination__link smrt-pagination__nav" data-smrt-part="item" type="button" disabled={!hasPrevPage} onclick={() => onPageChange(currentPage - 1)} aria-label={t(M['ui.pagination.previous_page'])}>
        &larr; Prev
      </button>
    {:else if hasPrevPage}
      <a href={getPageUrl(currentPage - 1)} class="smrt-pagination__link smrt-pagination__nav" data-smrt-part="item" aria-label={t(M['ui.pagination.previous_page'])}>
        &larr; Prev
      </a>
    {:else}
      <span class="smrt-pagination__link smrt-pagination__nav smrt-pagination__disabled" data-smrt-part="item" aria-hidden="true">&larr; Prev</span>
    {/if}

    <ul class="smrt-pagination__list" data-smrt-part="list">
      <!-- Key by index: getPageNumbers can emit two 'ellipsis' sentinels, whose
           value-identity would collide under a value-based key (#1586). -->
      {#each pageNumbers as page, i (i)}
        {#if page === 'ellipsis'}
          <li class="smrt-pagination__cell" data-smrt-part="cell">
            <span class="smrt-pagination__ellipsis" data-smrt-part="marker" aria-hidden="true">&hellip;</span>
          </li>
        {:else if page === currentPage}
          <li class="smrt-pagination__cell" data-smrt-part="cell">
            <span class="smrt-pagination__link smrt-pagination__current" data-smrt-part="item" aria-current="page" aria-label={t(M['ui.pagination.page_current'], { page })}>{page}</span>
          </li>
        {:else if onPageChange}
          <li class="smrt-pagination__cell" data-smrt-part="cell">
            <button class="smrt-pagination__link" data-smrt-part="item" type="button" onclick={() => onPageChange(page as number)} aria-label={t(M['ui.pagination.go_to_page'], { page })}>{page}</button>
          </li>
        {:else}
          <li class="smrt-pagination__cell" data-smrt-part="cell">
            <a href={getPageUrl(page)} class="smrt-pagination__link" data-smrt-part="item" aria-label={t(M['ui.pagination.go_to_page'], { page })}>{page}</a>
          </li>
        {/if}
      {/each}
    </ul>

    <!-- Next page -->
    {#if onPageChange}
      <button class="smrt-pagination__link smrt-pagination__nav" data-smrt-part="item" type="button" disabled={!hasNextPage} onclick={() => onPageChange(currentPage + 1)} aria-label={t(M['ui.pagination.next_page'])}>
        Next &rarr;
      </button>
    {:else if hasNextPage}
      <a href={getPageUrl(currentPage + 1)} class="smrt-pagination__link smrt-pagination__nav" data-smrt-part="item" aria-label={t(M['ui.pagination.next_page'])}>
        Next &rarr;
      </a>
    {:else}
      <span class="smrt-pagination__link smrt-pagination__nav smrt-pagination__disabled" data-smrt-part="item" aria-hidden="true">Next &rarr;</span>
    {/if}

    <!-- Last page -->
    {#if showFirstLast}
      {#if onPageChange}
        <button class="smrt-pagination__link smrt-pagination__nav smrt-pagination__last" data-smrt-part="item" type="button" disabled={isLastPage} onclick={() => onPageChange(totalPages)} aria-label={t(M['ui.pagination.last_page'], { totalPages })}>
          Last &raquo;
        </button>
      {:else if !isLastPage}
        <a href={getPageUrl(totalPages)} class="smrt-pagination__link smrt-pagination__nav smrt-pagination__last" data-smrt-part="item" aria-label={t(M['ui.pagination.last_page'], { totalPages })}>
          Last &raquo;
        </a>
      {:else}
        <span class="smrt-pagination__link smrt-pagination__nav smrt-pagination__disabled smrt-pagination__last" data-smrt-part="item" aria-hidden="true">Last &raquo;</span>
      {/if}
    {/if}
  </nav>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-pagination__root {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-8, 2rem);
    padding: var(--smrt-spacing-4, 1rem) 0;
    flex-wrap: wrap;
  }
  .smrt-pagination__root[data-density='touch'] {
    --smrt-control-target-min: var(--smrt-touch-target-min);
  }
  .smrt-pagination__root[data-density='comfortable'] {
    --smrt-control-target-min: 0px;
  }
  .smrt-pagination__list {
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    flex-wrap: wrap;
    justify-content: center;
    margin: 0;
    padding: 0;
  }
  .smrt-pagination__cell {
    margin: 0;
    padding: 0;
  }
  .smrt-pagination__link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: max(2.25rem, var(--smrt-control-target-min));
    height: 2.25rem;
    min-height: var(--smrt-control-target-min);
    padding: 0 var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-pagination__link.smrt-pagination__current {
    cursor: default;
  }
  .smrt-pagination__link.smrt-pagination__disabled,
  .smrt-pagination__link:disabled {
    cursor: not-allowed;
  }
  button.smrt-pagination__link {
    cursor: pointer;
  }
  .smrt-pagination__nav {
    padding: 0 var(--smrt-spacing-4, 1rem);
  }
  .smrt-pagination__nav.smrt-pagination__first,
  .smrt-pagination__nav.smrt-pagination__last {
    display: none;
  }
  @media (min-width: 640px) {
    .smrt-pagination__nav.smrt-pagination__first,
    .smrt-pagination__nav.smrt-pagination__last {
      display: inline-flex;
    }
  }
  .smrt-pagination__ellipsis {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    height: 2.25rem;
  }
  @media (max-width: 480px) {
    .smrt-pagination__link {
      min-width: max(2rem, var(--smrt-control-target-min));
      height: 2rem;
    }
    .smrt-pagination__nav {
      padding: 0 var(--smrt-spacing-2, 0.5rem);
    }
  }
}

@layer smrt.theme {
  .smrt-pagination__link {
    border-radius: var(--smrt-radius-small, 0.25rem);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    text-decoration: none;
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease), color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-pagination__link:not(.smrt-pagination__current):not(.smrt-pagination__disabled) {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
  }
  .smrt-pagination__link:not(.smrt-pagination__current):not(.smrt-pagination__disabled):hover {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary, white);
  }
  .smrt-pagination__link.smrt-pagination__current {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary, white);
  }
  .smrt-pagination__link.smrt-pagination__disabled,
  .smrt-pagination__link:disabled {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
  }
  button.smrt-pagination__link {
    border: none;
    font: inherit;
  }
  .smrt-pagination__ellipsis {
    color: var(--smrt-color-on-surface-variant);
  }
  @media (max-width: 480px) {
    .smrt-pagination__link {
      font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    }
  }
}

</style>
