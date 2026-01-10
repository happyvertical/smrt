<script lang="ts">
interface Props {
  currentPage: number;
  totalPages: number;
  baseUrl?: string;
}

const { currentPage, totalPages, baseUrl = '/articles' }: Props = $props();

function getPageUrl(page: number): string {
  if (page === 1) return baseUrl || '/';
  return `${baseUrl}/page/${page}`;
}

// Generate array of page numbers to display
function getPageNumbers(): (number | 'ellipsis')[] {
  const pages: (number | 'ellipsis')[] = [];
  const maxVisible = 5;

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
</script>

{#if totalPages > 1}
  <nav class="pagination" aria-label="Pagination">
    {#if hasPrevPage}
      <a href={getPageUrl(currentPage - 1)} class="page-link nav-link" aria-label="Previous page">
        &larr; Prev
      </a>
    {:else}
      <span class="page-link nav-link disabled" aria-hidden="true">&larr; Prev</span>
    {/if}

    <div class="page-numbers">
      {#each pageNumbers as page}
        {#if page === 'ellipsis'}
          <span class="ellipsis" aria-hidden="true">&hellip;</span>
        {:else if page === currentPage}
          <span class="page-link current" aria-current="page">{page}</span>
        {:else}
          <a href={getPageUrl(page)} class="page-link">{page}</a>
        {/if}
      {/each}
    </div>

    {#if hasNextPage}
      <a href={getPageUrl(currentPage + 1)} class="page-link nav-link" aria-label="Next page">
        Next &rarr;
      </a>
    {:else}
      <span class="page-link nav-link disabled" aria-hidden="true">Next &rarr;</span>
    {/if}
  </nav>
{/if}

<style>
  .pagination {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: var(--spacing-sm, 0.5rem);
    margin-top: var(--spacing-xl, 2rem);
    padding: var(--spacing-md, 1rem) 0;
    flex-wrap: wrap;
  }

  .page-numbers {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs, 0.25rem);
  }

  .page-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    height: 2.25rem;
    padding: 0 var(--spacing-sm, 0.5rem);
    border-radius: var(--radius-sm, 0.25rem);
    font-size: 0.875rem;
    font-weight: 500;
    text-decoration: none;
    transition: background-color 0.15s, color 0.15s;
  }

  .page-link:not(.current):not(.disabled) {
    background: var(--color-neutral-gray100, #f3f4f6);
    color: var(--color-neutral-gray700, #374151);
  }

  .page-link:not(.current):not(.disabled):hover {
    background: var(--color-primary, #2563eb);
    color: white;
  }

  .page-link.current {
    background: var(--color-primary, #2563eb);
    color: white;
    cursor: default;
  }

  .page-link.disabled {
    background: var(--color-neutral-gray100, #f3f4f6);
    color: var(--color-neutral-gray400, #9ca3af);
    cursor: not-allowed;
  }

  .nav-link {
    padding: 0 var(--spacing-md, 1rem);
  }

  .ellipsis {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    height: 2.25rem;
    color: var(--color-neutral-gray500, #6b7280);
  }

  @media (max-width: 480px) {
    .page-link {
      min-width: 2rem;
      height: 2rem;
      font-size: 0.8125rem;
    }

    .nav-link {
      padding: 0 var(--spacing-sm, 0.5rem);
    }
  }
</style>
