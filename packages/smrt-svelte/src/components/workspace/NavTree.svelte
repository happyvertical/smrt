<script lang="ts">
/**
 * NavTree — 3-level recursive sidebar nav primitive.
 *
 * Generic and prop-driven: no `$app/*` imports, no SvelteKit dependency.
 * Consumers pass `currentPath` (e.g. from `page.url.pathname`) and an
 * optional `iconComponent` for rendering `NavItem.icon` names. When no
 * icon component is supplied, the raw `icon` string is rendered as text
 * (useful for emoji / symbol icons).
 *
 * Active-state logic is overridable via `isActive`; the default treats
 * `currentPath === item.href` or `currentPath.startsWith(item.href + '/')`
 * as active (unless `item.exact === true`).
 *
 * In `collapsed` mode the component renders icon-only chips with a
 * native `title` tooltip; child rows are hidden unless their parent is
 * itself active (so the chip can highlight without expanding).
 */
import type { Component } from 'svelte';
import {
  defaultIsActive,
  isExpanded as isExpandedHelper,
  isItemOrChildActive,
} from './nav-helpers.js';
import type { NavItem } from './types.js';

interface Props {
  /** Top-level nav items. Each may have up to two levels of children. */
  items: NavItem[];
  /** Current pathname. Required — consumers pass `page.url.pathname` or similar. */
  currentPath: string;
  /** Called on link click. Consumers typically close a mobile drawer here. */
  onNavigate?: () => void;
  /** Override active-detection. Defaults to `defaultIsActive`. */
  isActive?: (item: NavItem, currentPath: string) => boolean;
  /**
   * Optional icon renderer. If omitted, `item.icon` is rendered as plain
   * text inside the icon slot — handy for emoji/symbol icons.
   */
  iconComponent?: Component<{ name: string; size?: number }>;
  /** Render in collapsed (icon-only) mode. */
  collapsed?: boolean;
  /** Accessible label for the surrounding `<nav>` element. */
  'aria-label'?: string;
}

const {
  items,
  currentPath,
  onNavigate,
  isActive: isActiveProp,
  iconComponent: IconComponent,
  collapsed = false,
  'aria-label': ariaLabel = 'Primary',
}: Props = $props();

const isActive = $derived(isActiveProp ?? defaultIsActive);

function checkActive(item: NavItem): boolean {
  return isActive(item, currentPath);
}

function checkParentActive(item: NavItem): boolean {
  return isItemOrChildActive(item, currentPath, isActive);
}

function checkExpanded(item: NavItem): boolean {
  return isExpandedHelper(item, currentPath, isActive);
}

/**
 * In collapsed (icon-rail) mode the children container is hidden, so a
 * parent whose descendant is active would otherwise lose any visible
 * "current location" indicator. Promote `parent-active` to `active`
 * styling in that mode.
 */
function checkEffectiveActive(item: NavItem): boolean {
  if (checkActive(item)) return true;
  if (collapsed && !!item.children?.length && checkParentActive(item))
    return true;
  return false;
}

/** Stable, HTML-safe id derived from an href for `aria-controls` pairing. */
function navChildrenId(href: string): string {
  const slug = href.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `smrt-nav-children-${slug || 'root'}`;
}
</script>

<nav class="smrt-nav-tree" class:collapsed aria-label={ariaLabel}>
  {#each items as item (item.href)}
    <a
      href={item.href}
      class="nav-item level-1"
      class:active={checkEffectiveActive(item) ||
        (checkActive(item) && !item.children?.length)}
      class:parent-active={checkParentActive(item) && !!item.children?.length}
      title={collapsed ? item.label : item.description}
      aria-expanded={item.children?.length ? checkExpanded(item) : undefined}
      aria-controls={item.children?.length
        ? navChildrenId(item.href)
        : undefined}
      onclick={onNavigate}
    >
      <span class="nav-icon-slot" aria-hidden="true">
        {#if IconComponent && item.icon}
          <IconComponent name={item.icon} size={18} />
        {:else if item.icon}
          <span class="nav-icon-text">{item.icon}</span>
        {/if}
      </span>
      {#if !collapsed}
        <span class="nav-label">{item.label}</span>
        {#if item.badge != null && item.badge !== ''}
          <span class="nav-badge">{item.badge}</span>
        {/if}
        {#if item.children?.length}
          <span
            class="nav-chevron"
            class:expanded={checkExpanded(item)}
            aria-hidden="true"
          >
            ›
          </span>
        {/if}
      {/if}
    </a>

    {#if item.children?.length}
      <div
        id={navChildrenId(item.href)}
        class="children level-2"
        class:expanded={!collapsed && checkExpanded(item)}
      >
        {#each item.children as child (child.href)}
          <a
            href={child.href}
            class="nav-item level-2"
            class:active={checkActive(child) && !child.children?.length}
            class:parent-active={checkParentActive(child) && !!child.children?.length}
            title={child.description}
            aria-expanded={child.children?.length
              ? checkExpanded(child)
              : undefined}
            aria-controls={child.children?.length
              ? navChildrenId(child.href)
              : undefined}
            onclick={onNavigate}
          >
            <span class="nav-icon-slot" aria-hidden="true">
              {#if IconComponent && child.icon}
                <IconComponent name={child.icon} size={16} />
              {:else if child.icon}
                <span class="nav-icon-text">{child.icon}</span>
              {/if}
            </span>
            <span class="nav-label">{child.label}</span>
            {#if child.badge != null && child.badge !== ''}
              <span class="nav-badge">{child.badge}</span>
            {/if}
            {#if child.children?.length}
              <span
                class="nav-chevron"
                class:expanded={checkExpanded(child)}
                aria-hidden="true"
              >
                ›
              </span>
            {/if}
          </a>

          {#if child.children?.length}
            <div
              id={navChildrenId(child.href)}
              class="children level-3"
              class:expanded={!collapsed && checkExpanded(child)}
            >
              {#each child.children as grandchild (grandchild.href)}
                <a
                  href={grandchild.href}
                  class="nav-item level-3"
                  class:active={checkActive(grandchild)}
                  title={grandchild.description}
                  onclick={onNavigate}
                >
                  <span class="nav-icon-slot" aria-hidden="true">
                    {#if IconComponent && grandchild.icon}
                      <IconComponent name={grandchild.icon} size={15} />
                    {:else if grandchild.icon}
                      <span class="nav-icon-text">{grandchild.icon}</span>
                    {/if}
                  </span>
                  <span class="nav-label">{grandchild.label}</span>
                  {#if grandchild.badge != null && grandchild.badge !== ''}
                    <span class="nav-badge">{grandchild.badge}</span>
                  {/if}
                </a>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  {/each}
</nav>

<style>
  .smrt-nav-tree {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    color: var(--smrt-color-on-surface-variant);
    text-decoration: none;
    transition:
      color 0.15s ease,
      background 0.15s ease,
      border-color 0.15s ease;
    border-left: 3px solid transparent;
  }

  .nav-item:hover {
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface-container-high);
  }

  .nav-item:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .nav-item.active {
    color: var(--smrt-color-on-primary-container);
    background: var(--smrt-color-primary-container);
    border-left-color: var(--smrt-color-primary);
  }

  .nav-item.parent-active {
    color: var(--smrt-color-on-surface);
    font-weight: 500;
  }

  .nav-icon-slot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    flex-shrink: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .nav-icon-text {
    font-size: 1rem;
    line-height: 1;
  }

  .nav-label {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nav-badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    padding: 0 0.4rem;
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1.2;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }

  .nav-chevron {
    flex-shrink: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 1rem;
    line-height: 1;
    transform: rotate(0deg);
    transition:
      transform 0.15s ease,
      color 0.15s ease;
  }

  .nav-chevron.expanded {
    transform: rotate(90deg);
    color: var(--smrt-color-on-surface);
  }

  /* Level 1 */
  .nav-item.level-1 {
    padding: 0.625rem 1rem;
    font-size: 0.875rem;
  }

  /* Level 2 */
  .nav-item.level-2 {
    padding: 0.5rem 1rem 0.5rem 2.75rem;
    font-size: 0.8125rem;
  }
  .nav-item.level-2 .nav-icon-slot {
    width: 1rem;
  }
  .nav-item.level-2 .nav-icon-text {
    font-size: 0.875rem;
  }

  /* Level 3 */
  .nav-item.level-3 {
    padding: 0.45rem 1rem 0.45rem 4rem;
    font-size: 0.78rem;
  }
  .nav-item.level-3 .nav-icon-slot {
    width: 0.95rem;
  }
  .nav-item.level-3 .nav-icon-text {
    font-size: 0.8125rem;
  }

  /* Children containers — collapsed by default, shown when .expanded */
  .children {
    display: none;
    flex-direction: column;
  }
  .children.expanded {
    display: flex;
  }

  /* Collapsed (icon-only) mode */
  .smrt-nav-tree.collapsed .nav-item.level-1 {
    justify-content: center;
    padding: 0.625rem 0.5rem;
  }
  .smrt-nav-tree.collapsed .nav-label,
  .smrt-nav-tree.collapsed .nav-chevron,
  .smrt-nav-tree.collapsed .nav-badge {
    display: none;
  }
  /* In collapsed mode, never show nested children. */
  .smrt-nav-tree.collapsed .children {
    display: none;
  }
</style>
