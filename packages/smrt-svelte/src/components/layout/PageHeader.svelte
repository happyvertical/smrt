<script lang="ts">
/**
 * PageHeader - Standard page header with optional back navigation
 * refactored for Material 3
 *
 * Provides consistent page header layout with title, optional back link,
 * and slot for action buttons.
 */
import type { Snippet } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import { Icon } from '../display/index.js';

export interface Props {
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
        <a href={backHref} class="back-link" use:ripple>
          <Icon name="chevron-left" size={20} />
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
    margin-bottom: 2rem;
    padding-top: 1rem;
  }

  .header-main {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .header-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 200px;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-large-font);
    text-decoration: none;
    margin-bottom: 0.75rem;
    padding: 4px 8px 4px 4px;
    border-radius: 8px;
    margin-left: -4px; /* Align icon with text below */
    transition: background-color 200ms;
  }

  .back-link:hover {
    background-color: var(--smrt-color-surface-container-high);
  }

  .page-title {
    font: var(--smrt-typography-headline-medium-font);
    color: var(--smrt-color-on-surface);
    margin: 0;
    letter-spacing: -0.5px;
  }

  .page-subtitle {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
    margin: 0;
    margin-top: 4px;
  }

  .header-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .header-extra {
    margin-top: 1.5rem;
  }
</style>