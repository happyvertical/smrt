<script lang="ts">
/**
 * Tabs - Tab navigation component
 * refactored for Material 3
 *
 * Provides tabbed navigation with optional counts and content slots.
 *
 * Accessibility:
 * - Supports keyboard navigation with Arrow keys
 * - Proper ARIA roles: tablist, tab, tabpanel
 * - aria-selected indicates active tab
 * - aria-controls links tab to panel
 *
 * Link tabs: give every tab an `href` and the row renders as navigation — a
 * `<nav>` of links with `aria-current="page"` on the active one, each tab its
 * own URL (a content item's Article / Images / Review pages). With
 * `maxVisible`, extra link tabs move to a "More" menu while the active tab
 * always stays in the row; `badge` marks a tab needing attention (and puts a
 * dot on "More" when a hidden tab has one). The row scrolls sideways on
 * phones and keeps the active tab scrolled into view. It carries
 * `data-shell-tabs`, so AdminShell keeps it sticky under its phone top bar.
 */
import type { Snippet } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import { splitTabs } from './tabs-overflow.js';
import type { Tab } from './types.js';

export interface Props {
  /** Available tabs */
  tabs: Tab[];
  /** Currently active tab id */
  active: string;
  /** Called when tab changes */
  onchange?: (id: string) => void;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Visual variant */
  variant?: 'primary' | 'secondary';
  /** Tab content slot */
  children?: Snippet;
  /** Accessible label for the tablist */
  'aria-label'?: string;
  /** Link tabs only: most tabs shown in the row; the rest go under "More". */
  maxVisible?: number;
  /** Link tabs only: label of the overflow menu (default "More"). */
  moreLabel?: string;
  /** Link tabs only: screen-reader text for the "More" attention dot. */
  moreBadgeLabel?: string;
}

const {
  tabs,
  active,
  onchange,
  size = 'md',
  variant = 'primary',
  children,
  'aria-label': ariaLabel,
  maxVisible,
  moreLabel = 'More',
  moreBadgeLabel = 'has updates',
}: Props = $props();

/** Link tabs: every tab has an href, so the row is navigation, not a tablist. */
const linkMode = $derived(tabs.length > 0 && tabs.every((tab) => !!tab.href));
const split = $derived(
  linkMode
    ? splitTabs(tabs, active, maxVisible)
    : { visible: tabs, overflow: [] as Tab[] },
);
const overflowHasBadge = $derived(
  split.overflow.some((tab) => tab.badge !== undefined && tab.badge !== null),
);
let moreMenu = $state<HTMLDetailsElement | null>(null);
let linkRow = $state<HTMLElement | null>(null);

// Keep the active link tab scrolled into view in a sideways-scrolling row,
// and close "More" once the active tab changes (a link was followed).
$effect(() => {
  const current = active;
  if (!linkMode || !linkRow) return;
  if (moreMenu) moreMenu.open = false;
  const activeLink = linkRow.querySelector<HTMLElement>(
    `[data-tab-id="${CSS.escape(current)}"]`,
  );
  activeLink?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
});

function hasBadge(tab: Tab): boolean {
  return tab.badge !== undefined && tab.badge !== null && tab.badge !== '';
}

/** Get enabled tabs only */
const enabledTabs = $derived(tabs.filter((t) => !t.disabled));

let tablistEl: HTMLElement | null = $state(null);

// Generate unique ID for this tabs instance
const instanceId = $props.id();

function handleClick(id: string) {
  if (id !== active) {
    onchange?.(id);
  }
}

/**
 * Handle keyboard navigation for accessibility
 * ArrowRight/ArrowLeft: Move between tabs
 * Home: Go to first tab
 * End: Go to last tab
 */
function handleKeydown(event: KeyboardEvent, tabId: string) {
  const currentIndex = enabledTabs.findIndex((t) => t.id === tabId);
  let nextIndex: number | null = null;

  switch (event.key) {
    case 'ArrowRight':
      event.preventDefault();
      nextIndex = (currentIndex + 1) % enabledTabs.length;
      break;
    case 'ArrowLeft':
      event.preventDefault();
      nextIndex = (currentIndex - 1 + enabledTabs.length) % enabledTabs.length;
      break;
    case 'Home':
      event.preventDefault();
      nextIndex = 0;
      break;
    case 'End':
      event.preventDefault();
      nextIndex = enabledTabs.length - 1;
      break;
  }

  if (nextIndex !== null && nextIndex !== currentIndex) {
    const nextTab = enabledTabs[nextIndex];
    if (nextTab) {
      onchange?.(nextTab.id);
      // Focus the next tab button after the DOM updates
      requestAnimationFrame(() => {
        const tabButton = tablistEl?.querySelector(
          `[data-tab-id="${CSS.escape(nextTab.id)}"]`,
        ) as HTMLElement;
        tabButton?.focus();
      });
    }
  }
}
</script>

{#snippet linkTab(tab: Tab)}
  <a
    class="tab-link"
    class:active={tab.id === active}
    href={tab.disabled ? undefined : tab.href}
    aria-current={tab.id === active ? 'page' : undefined}
    aria-disabled={tab.disabled ? 'true' : undefined}
    data-tab-id={tab.id}
    onclick={() => handleClick(tab.id)}
  >
    <span class="tab-label">{tab.label}</span>
    {#if tab.count !== undefined}
      <span class="tab-count">{tab.count}</span>
    {/if}
    {#if hasBadge(tab)}
      <span class="tab-badge">{tab.badge}</span>
    {/if}
  </a>
{/snippet}

{#if linkMode}
<div class="tabs-container">
  <nav
    class="tabs-links"
    class:sm={size === 'sm'}
    class:lg={size === 'lg'}
    aria-label={ariaLabel}
    data-shell-tabs
  >
    <div class="tabs-links-row" bind:this={linkRow}>
      {#each split.visible as tab (tab.id)}
        {@render linkTab(tab)}
      {/each}
    </div>
    {#if split.overflow.length > 0}
      <details class="tabs-more" bind:this={moreMenu}>
        <summary class="tab-link">
          <span class="tab-label">{moreLabel}</span>
          {#if overflowHasBadge}
            <span class="tab-dot" aria-hidden="true"></span>
            <span class="visually-hidden">({moreBadgeLabel})</span>
          {/if}
        </summary>
        <div class="tabs-more-menu">
          {#each split.overflow as tab (tab.id)}
            {@render linkTab(tab)}
          {/each}
        </div>
      </details>
    {/if}
  </nav>
  {#if children}
    <div class="tab-panel">
      {@render children()}
    </div>
  {/if}
</div>
{:else}
<div class="tabs-container">
  <div
    class="tabs-nav"
    class:sm={size === 'sm'}
    class:lg={size === 'lg'}
    class:secondary={variant === 'secondary'}
    role="tablist"
    aria-label={ariaLabel}
    bind:this={tablistEl}
  >
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        class="tab-button"
        class:active={tab.id === active}
        disabled={tab.disabled}
        role="tab"
        id="tab-{instanceId}-{tab.id}"
        aria-selected={tab.id === active}
        aria-controls="tab-panel-{instanceId}"
        tabindex={tab.id === active ? 0 : -1}
        data-tab-id={tab.id}
        onclick={() => handleClick(tab.id)}
        onkeydown={(e) => handleKeydown(e, tab.id)}
        use:ripple
      >
        <span class="tab-content-wrapper">
          <span class="tab-label">{tab.label}</span>
          {#if tab.count !== undefined}
            <span class="tab-count">{tab.count}</span>
          {/if}
          {#if hasBadge(tab)}
            <span class="tab-badge">{tab.badge}</span>
          {/if}
        </span>
        <div class="active-indicator"></div>
      </button>
    {/each}
  </div>

  {#if children}
    <div 
      class="tab-panel" 
      role="tabpanel" 
      id="tab-panel-{instanceId}"
      aria-labelledby="tab-{instanceId}-{active}"
    >
      {@render children()}
    </div>
  {/if}
</div>
{/if}

<style>
  .tabs-container {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .tabs-nav {
    display: flex;
    border-bottom: 1px solid var(--smrt-color-surface-variant);
    width: 100%;
  }

  .tab-button {
    flex: 1;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0 var(--smrt-spacing-4, 16px);
    height: 48px;
    font: var(--smrt-typography-title-small-font);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    position: relative;
    overflow: hidden;
    min-width: 90px;
  }

  .sm .tab-button {
    height: 40px;
    font: var(--smrt-typography-label-large-font);
  }

  .lg .tab-button {
    height: 56px;
    font: var(--smrt-typography-title-medium-font);
  }

  .tab-button:hover:not(:disabled) {
    background-color: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
  }

  .tab-button:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .tab-button.active {
    color: var(--smrt-color-primary);
  }

  .tab-button:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .tab-content-wrapper {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    height: 100%;
  }

  .tab-count {
    font: var(--smrt-typography-label-small-font);
    opacity: 0.7;
  }

  .active-indicator {
    position: absolute;
    bottom: 0;
    height: 3px;
    background-color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-sm, 4px) var(--smrt-radius-sm, 4px) 0 0;
    transition: width 200ms, opacity 200ms;
    width: 0;
    opacity: 0;
  }

  .active .active-indicator {
    width: 40px; /* Primary variant indicator width */
    opacity: 1;
  }

  /* Secondary variant - full width indicator */
  .secondary .active .active-indicator {
    width: 100%;
    height: 2px;
  }

  .tab-panel {
    padding-top: 1.5rem;
  }

  .tab-badge {
    min-width: 1.25rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-align: center;
  }

  /* Link tabs: a navigation row, one URL per tab. */
  .tabs-links {
    display: flex;
    align-items: stretch;
    gap: var(--smrt-spacing-1, 4px);
    width: 100%;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .tabs-links-row {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    gap: var(--smrt-spacing-1, 4px);
    overflow-x: auto;
    scrollbar-width: thin;
  }

  .tab-link {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    min-height: 44px;
    padding: 0 var(--smrt-spacing-4, 16px);
    margin-bottom: -1px;
    border-bottom: 2px solid transparent;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-title-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }

  .tabs-links.sm .tab-link {
    min-height: 40px;
    font: var(--smrt-typography-label-large-font);
  }

  .tabs-links.lg .tab-link {
    min-height: 56px;
    font: var(--smrt-typography-title-medium-font);
  }

  .tab-link:hover {
    color: var(--smrt-color-on-surface);
  }

  .tab-link.active {
    border-bottom-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }

  .tab-link[aria-disabled='true'] {
    opacity: 0.38;
    cursor: not-allowed;
  }

  .tab-link:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .tab-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: var(--smrt-color-primary);
  }

  .tabs-more {
    position: relative;
    flex: 0 0 auto;
  }

  .tabs-more summary {
    list-style: none;
  }

  .tabs-more summary::-webkit-details-marker {
    display: none;
  }

  .tabs-more-menu {
    position: absolute;
    inset-inline-end: 0;
    z-index: var(--smrt-z-index-dropdown, 20);
    display: grid;
    min-width: 12rem;
    padding: var(--smrt-spacing-1, 4px);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-small, 0.5rem);
    background: var(--smrt-color-surface);
    box-shadow: var(--smrt-elevation-2);
  }

  .tabs-more-menu .tab-link {
    margin: 0;
    border-bottom: 0;
    border-radius: var(--smrt-radius-extra-small, 0.35rem);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>