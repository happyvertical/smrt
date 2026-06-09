<script lang="ts">
/**
 * EmptyState - Placeholder for empty lists/content
 * refactored for Material 3
 *
 * Provides a consistent empty state display with optional icon,
 * description, and call-to-action button.
 */
import type { Snippet } from 'svelte';
import { ripple } from '../../actions/ripple.js';

export interface Props {
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
  document: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z"/>
    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
  </svg>`,
  folder: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
  </svg>`,
  users: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
  </svg>`,
  search: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <circle cx="11" cy="11" r="8"/>
    <path d="M21 21l-4.35-4.35"/>
  </svg>`,
  inbox: `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path d="M22 12h-6l-2 3h-4l-2-3H2"/>
    <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
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
      <a href={actionHref} class="action-button" use:ripple>
        {actionLabel}
      </a>
    {:else if onaction}
      <button type="button" class="action-button" onclick={onaction} use:ripple>
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
    padding: 4rem 2rem;
    text-align: center;
  }

  .empty-state.sm {
    padding: 2rem 1.5rem;
  }

  .empty-state.lg {
    padding: 6rem 3rem;
  }

  .icon-container {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 96px;
    height: 96px;
    margin-bottom: 2rem;
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    border-radius: var(--smrt-radius-3xl, 32px); /* M3 extra large shape */
    padding: var(--smrt-spacing-6, 24px);
  }

  .sm .icon-container {
    width: 64px;
    height: 64px;
    margin-bottom: 1.5rem;
    border-radius: var(--smrt-radius-xl, 16px);
    padding: var(--smrt-spacing-4, 16px);
  }

  .lg .icon-container {
    width: 120px;
    height: 120px;
    margin-bottom: 2.5rem;
    border-radius: var(--smrt-radius-3xl, 32px);
    padding: var(--smrt-spacing-8, 32px);
  }

  .empty-title {
    font: var(--smrt-typography-title-large-font);
    color: var(--smrt-color-on-surface);
    margin: 0 0 0.75rem;
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .sm .empty-title {
    font: var(--smrt-typography-title-medium-font);
  }

  .lg .empty-title {
    font: var(--smrt-typography-headline-small-font);
  }

  .empty-description {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
    margin: 0 0 2rem;
    max-width: 440px;
    line-height: var(--smrt-typography-body-medium-line-height, 1.5);
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: 0 var(--smrt-spacing-6, 24px);
    height: 40px;
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-primary);
    background-color: var(--smrt-color-primary);
    border: none;
    border-radius: var(--smrt-radius-2xl, 24px);
    text-decoration: none;
    cursor: pointer;
    transition: box-shadow 200ms, background-color 200ms;
    position: relative;
    overflow: hidden;
    box-shadow: var(--smrt-elevation-1);
  }

  .action-button:hover {
    background-color: var(--smrt-color-primary);
    box-shadow: var(--smrt-elevation-2);
  }
</style>