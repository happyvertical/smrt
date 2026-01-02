<script lang="ts">
/**
 * EmptyState - Placeholder for empty lists/content
 *
 * Provides a consistent empty state display with optional icon,
 * description, and call-to-action button.
 */

import type { Snippet } from 'svelte';

interface Props {
  /** Main title text */
  title: string;
  /** Optional description */
  description?: string;
  /** Icon slot or default icon name */
  icon?: 'document' | 'folder' | 'users' | 'search' | 'inbox' | Snippet;
  /** Action button label */
  actionLabel?: string;
  /** Action button href */
  actionHref?: string;
  /** Action button click handler */
  onaction?: () => void;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
}

const {
  title,
  description,
  icon = 'inbox',
  actionLabel,
  actionHref,
  onaction,
  size = 'md',
}: Props = $props();

// Default SVG icons
const icons = {
  document: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M14 6h14l10 10v26a2 2 0 01-2 2H14a2 2 0 01-2-2V8a2 2 0 012-2z"/>
    <path d="M28 6v10h10"/>
    <path d="M18 26h12M18 34h8"/>
  </svg>`,
  folder: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M6 14a2 2 0 012-2h10l4 4h18a2 2 0 012 2v18a2 2 0 01-2 2H8a2 2 0 01-2-2V14z"/>
  </svg>`,
  users: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="20" cy="18" r="6"/>
    <path d="M8 38v-2a8 8 0 018-8h8a8 8 0 018 8v2"/>
    <circle cx="34" cy="16" r="4"/>
    <path d="M40 38v-2a6 6 0 00-4-5.65"/>
  </svg>`,
  search: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="20" cy="20" r="12"/>
    <path d="M30 30l10 10"/>
  </svg>`,
  inbox: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M8 24h10l4 6h4l4-6h10"/>
    <path d="M10 12h28a2 2 0 012 2v22a2 2 0 01-2 2H10a2 2 0 01-2-2V14a2 2 0 012-2z"/>
  </svg>`,
};
</script>

<div class="empty-state" class:sm={size === 'sm'} class:lg={size === 'lg'}>
  <div class="icon-container">
    {#if typeof icon === 'string'}
      {@html icons[icon] ?? icons.inbox}
    {:else}
      {@render icon()}
    {/if}
  </div>

  <h3 class="empty-title">{title}</h3>

  {#if description}
    <p class="empty-description">{description}</p>
  {/if}

  {#if actionLabel}
    {#if actionHref}
      <a href={actionHref} class="action-button">
        {actionLabel}
      </a>
    {:else if onaction}
      <button type="button" class="action-button" onclick={onaction}>
        {actionLabel}
      </button>
    {/if}
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 1.5rem;
    text-align: center;
  }

  .empty-state.sm {
    padding: 1.5rem 1rem;
  }

  .empty-state.lg {
    padding: 4rem 2rem;
  }

  .icon-container {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 80px;
    height: 80px;
    margin-bottom: 1.5rem;
    background: #f3f4f6;
    border-radius: 50%;
    color: #9ca3af;
  }

  .sm .icon-container {
    width: 56px;
    height: 56px;
    margin-bottom: 1rem;
  }

  .sm .icon-container :global(svg) {
    width: 32px;
    height: 32px;
  }

  .lg .icon-container {
    width: 96px;
    height: 96px;
    margin-bottom: 2rem;
  }

  .lg .icon-container :global(svg) {
    width: 56px;
    height: 56px;
  }

  .empty-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: #374151;
    margin: 0 0 0.5rem;
  }

  .sm .empty-title {
    font-size: 1rem;
  }

  .lg .empty-title {
    font-size: 1.25rem;
  }

  .empty-description {
    font-size: 0.875rem;
    color: #6b7280;
    margin: 0 0 1.5rem;
    max-width: 400px;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: white;
    background: #3b82f6;
    border: none;
    border-radius: 0.375rem;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s;
  }

  .action-button:hover {
    background: #2563eb;
  }
</style>
