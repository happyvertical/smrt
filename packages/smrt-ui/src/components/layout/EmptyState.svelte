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

<div class="smrt-empty-state__root" class:smrt-empty-state__sm={size === 'sm'} class:smrt-empty-state__lg={size === 'lg'} data-smrt-component="EmptyState">
  <div class="smrt-empty-state__icon" data-smrt-part="icon">
    {#if typeof icon === 'string'}
      {@html icons[icon] ?? icons.inbox}
    {:else}
      {@render icon()}
    {/if}
  </div>

  <h3 class="smrt-empty-state__title" data-smrt-part="title">{title}</h3>

  {#if description}
    <p class="smrt-empty-state__description" data-smrt-part="description">{description}</p>
  {/if}

  {#if actionLabel}
    {#if actionHref}
      <a href={actionHref} class="smrt-empty-state__action" data-smrt-part="trigger" use:ripple>
        {actionLabel}
      </a>
    {:else if onaction}
      <button type="button" class="smrt-empty-state__action" data-smrt-part="trigger" onclick={onaction} use:ripple>
        {actionLabel}
      </button>
    {/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-empty-state__root {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 2rem;
  }
  .smrt-empty-state__root.smrt-empty-state__sm {
    padding: 2rem 1.5rem;
  }
  .smrt-empty-state__root.smrt-empty-state__lg {
    padding: 6rem 3rem;
  }
  .smrt-empty-state__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 96px;
    height: 96px;
    margin-bottom: 2rem;
    /* M3 extra large shape */
    padding: var(--smrt-spacing-6);
  }
  .smrt-empty-state__sm .smrt-empty-state__icon {
    width: 64px;
    height: 64px;
    margin-bottom: 1.5rem;
    padding: var(--smrt-spacing-4);
  }
  .smrt-empty-state__lg .smrt-empty-state__icon {
    width: 120px;
    height: 120px;
    margin-bottom: 2.5rem;
    padding: var(--smrt-spacing-8);
  }
  .smrt-empty-state__title {
    margin: 0 0 0.75rem;
  }
  .smrt-empty-state__description {
    margin: 0 0 2rem;
    max-width: 440px;
  }
  .smrt-empty-state__action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--smrt-spacing-2);
    padding: 0 var(--smrt-spacing-6);
    height: 40px;
    cursor: pointer;
    position: relative;
    overflow: hidden;
  }
}

@layer smrt.theme {
  .smrt-empty-state__root {
    text-align: center;
  }
  .smrt-empty-state__icon {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    border-radius: var(--smrt-radius-3xl);
  }
  .smrt-empty-state__sm .smrt-empty-state__icon {
    border-radius: var(--smrt-radius-xl);
  }
  .smrt-empty-state__lg .smrt-empty-state__icon {
    border-radius: var(--smrt-radius-3xl);
  }
  .smrt-empty-state__title {
    font: var(--smrt-typography-title-large-font);
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-empty-state__sm .smrt-empty-state__title {
    font: var(--smrt-typography-title-medium-font);
  }
  .smrt-empty-state__lg .smrt-empty-state__title {
    font: var(--smrt-typography-headline-small-font);
  }
  .smrt-empty-state__description {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
    line-height: var(--smrt-typography-body-medium-line-height, 1.5);
  }
  .smrt-empty-state__action {
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-primary);
    background-color: var(--smrt-color-primary);
    border: none;
    border-radius: var(--smrt-radius-2xl);
    text-decoration: none;
    transition: box-shadow 200ms, background-color 200ms;
    box-shadow: var(--smrt-elevation-1);
  }
  .smrt-empty-state__action:hover {
    background-color: var(--smrt-color-primary);
    box-shadow: var(--smrt-elevation-2);
  }
}

</style>