<script lang="ts">
/**
 * PageHeader - Standard page header with optional back navigation
 *
 * Provides consistent page header layout with title, optional back link,
 * and slot for action buttons.
 */

import type { Snippet } from 'svelte';

interface Props {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /** Back navigation URL */
  backHref?: string;
  /** Back link label */
  backLabel?: string;
  /** Slot for action buttons */
  actions?: Snippet;
  /** Slot for additional content below title */
  children?: Snippet;
}

const {
  title,
  subtitle,
  backHref,
  backLabel = 'Back',
  actions,
  children,
}: Props = $props();
</script>

<header class="page-header">
  <div class="header-main">
    <div class="header-content">
      {#if backHref}
        <a href={backHref} class="back-link">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 4l-6 6 6 6" />
          </svg>
          <span>{backLabel}</span>
        </a>
      {/if}
      <h1 class="page-title">{title}</h1>
      {#if subtitle}
        <p class="page-subtitle">{subtitle}</p>
      {/if}
    </div>

    {#if actions}
      <div class="header-actions">
        {@render actions()}
      </div>
    {/if}
  </div>

  {#if children}
    <div class="header-extra">
      {@render children()}
    </div>
  {/if}
</header>

<style>
  .page-header {
    margin-bottom: 1.5rem;
  }

  .header-main {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .header-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: #6b7280;
    font-size: 0.875rem;
    text-decoration: none;
    margin-bottom: 0.5rem;
    transition: color 0.15s;
  }

  .back-link:hover {
    color: #3b82f6;
  }

  .page-title {
    font-size: 1.5rem;
    font-weight: 600;
    color: #111827;
    margin: 0;
    line-height: 1.2;
  }

  .page-subtitle {
    font-size: 0.875rem;
    color: #6b7280;
    margin: 0;
    margin-top: 0.25rem;
  }

  .header-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .header-extra {
    margin-top: 1rem;
  }
</style>
