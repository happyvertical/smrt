<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { type Component, onMount } from 'svelte';
import { fly } from 'svelte/transition';
import { M } from '../../../i18n/strings.workspace.js';
import { flipRow } from './motion.js';
import ShellSectionIcon from './ShellSectionIcon.svelte';
import {
  SHELL_DEFAULT_SECTION_ICON,
  SHELL_PLACEHOLDER_ICON,
} from './shell-icons.js';
import type { ShellNavGroup, ShellNavItem } from './types.js';

const DEFAULT_ACTION_ICON = 'settings';

interface Props {
  /** Navigation items with href, label, icon, and optional children. */
  items?: ShellNavItem[];
  /** Labelled, collapsible navigation groups, rendered after flat items. */
  groups?: ShellNavGroup[];
  /** Accessible name for this navigation landmark. */
  'aria-label'?: string;
  /** Target density; omit to inherit the theme density. */
  density?: 'comfortable' | 'touch';
  /** Current URL to highlight the active navigation link. */
  currentHref?: string;
  /** Component used to render icon names as SVG or custom icons. */
  iconComponent?: Component<{ name: string; size?: number }>;
  /** Hide labels and show only icons in a compact layout. */
  collapsed?: boolean;
  /** Called when the user clicks a navigation link. */
  onNavigate?: () => void;
  /**
   * `'items'` (default) lists every group's entries. `'sections'` shows only
   * the sections. `'sections-with-items'` also shows entries when expanded.
   * Section links go to the section's own page
   * (`ShellNavGroup.href`, else `sectionHref(id)`, else its first entry).
   */
  navMode?: 'items' | 'sections' | 'sections-with-items';
  /** Section page for groups without an `href` (e.g. user-created ones). */
  sectionHref?: (sectionId: string) => string | undefined;
}

let {
  items = [],
  groups = [],
  'aria-label': ariaLabel,
  density,
  currentHref = '',
  iconComponent: IconComponent,
  collapsed = false,
  onNavigate,
  navMode = 'items',
  sectionHref,
}: Props = $props();
const { t } = useI18n();
let ready = $state(false);
onMount(() => {
  ready = true;
});

function reveal() {
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const canAnimate =
    typeof Element !== 'undefined' &&
    typeof Element.prototype.animate === 'function';
  return { x: 12, duration: ready && !reduced && canAnimate ? 260 : 0 };
}

function isActive(item: ShellNavItem): boolean {
  return item.href === currentHref || currentHref.startsWith(`${item.href}/`);
}

/** True when the item, any child, or its action link is the current page. */
function isItemCurrent(item: ShellNavItem): boolean {
  return (
    isActive(item) ||
    !!item.children?.some((child) => isActive(child)) ||
    (!!item.action && isActive(item.action))
  );
}

function isGroupCurrent(group: ShellNavGroup): boolean {
  return group.items.some(isItemCurrent);
}

function groupId(group: ShellNavGroup): string {
  return group.id ?? group.heading;
}

function groupHref(group: ShellNavGroup): string | undefined {
  return group.href ?? sectionHref?.(groupId(group)) ?? group.items[0]?.href;
}

/** A section is current on its own page or on any of its entries' pages. */
function isSectionCurrent(group: ShellNavGroup): boolean {
  const href = groupHref(group);
  return (
    (!!href && (href === currentHref || currentHref.startsWith(`${href}/`))) ||
    isGroupCurrent(group)
  );
}

function showAction(item: ShellNavItem, sectionCurrent: boolean): boolean {
  if (collapsed || !item.action) return false;
  return item.action.visibility !== 'active' || sectionCurrent;
}

function isVisibleActive(item: ShellNavItem): boolean {
  if (isActive(item)) return true;
  return collapsed && isItemCurrent(item);
}

/** Accessible label of an item's attention dot, or null when it has none. */
function attentionLabel(item: ShellNavItem): string | null {
  if (!item.attention) return null;
  return typeof item.attention === 'string' && item.attention.trim()
    ? item.attention.trim()
    : t(M['ui.tenant_nav.needs_attention']);
}

function fallbackIcon(label: string): string {
  return label.trim().charAt(0).toLocaleUpperCase() || '?';
}
</script>

{#snippet glyph(name: string, size: number)}
  {#if IconComponent}
    <IconComponent {name} {size} />
  {:else}
    <ShellSectionIcon {name} {size} />
  {/if}
{/snippet}

{#snippet attention(item: ShellNavItem)}
  {@const label = attentionLabel(item)}
  {#if label}
    <span
      class="smrt-tenant-nav__attention"
      data-attention
      aria-hidden="true"
    ></span>
    <span class="smrt-tenant-nav__sr-only">({label})</span>
  {/if}
{/snippet}

{#snippet navItems(entries: ShellNavItem[], groupCurrent?: boolean)}
  {#each entries as item (item.href)}
    {@const action = showAction(item, groupCurrent ?? isItemCurrent(item))
      ? item.action
      : undefined}
    <div class="smrt-tenant-nav__section" in:fly={reveal()} animate:flipRow>
      <div class="smrt-tenant-nav__row">
      <a
        href={item.href}
        class:smrt-tenant-nav__link--visible-active={isVisibleActive(item)}
        aria-current={isActive(item) ? 'page' : undefined}
        title={collapsed ? item.label : item.description}
        onclick={onNavigate}
      >
        {#if item.icon}
          <span class="smrt-tenant-nav__icon" aria-hidden="true">
            {@render glyph(item.icon, 18)}
          </span>
        {:else if collapsed}
          <span
            class="smrt-tenant-nav__icon smrt-tenant-nav__icon--placeholder"
            aria-hidden="true"
          >
            <ShellSectionIcon name={SHELL_PLACEHOLDER_ICON} size={18} />
          </span>
        {/if}
        {#if collapsed}
          <span class="smrt-tenant-nav__sr-only">{item.label}</span>
        {:else}
          <strong>{item.label}</strong>
          {#if item.badge !== null && item.badge !== undefined}
            <small>{item.badge}</small>
          {/if}
        {/if}
        {@render attention(item)}
      </a>
      {#if action}
        <a
          href={action.href}
          class="smrt-tenant-nav__action"
          aria-label={action.label}
          aria-current={isActive(action) ? 'page' : undefined}
          title={action.label}
          onclick={onNavigate}
        >
          <span class="smrt-tenant-nav__icon" aria-hidden="true">
            {@render glyph(action.icon ?? DEFAULT_ACTION_ICON, 16)}
          </span>
        </a>
      {/if}
      </div>
      {#if item.children?.length && !collapsed}
        <div class="smrt-tenant-nav__children">
          {#each item.children as child (child.href)}
            <a
              href={child.href}
              aria-current={isActive(child) ? 'page' : undefined}
              onclick={onNavigate}
            >
              {#if child.icon}
                <span class="smrt-tenant-nav__icon" aria-hidden="true">
                  {@render glyph(child.icon, 16)}
                </span>
              {/if}
              <span>{child.label}</span>
              {#if child.badge !== null && child.badge !== undefined}
                <small>{child.badge}</small>
              {/if}
              {@render attention(child)}
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
{/snippet}

<nav
  class="smrt-tenant-nav"
  data-density={density}
  class:smrt-tenant-nav--collapsed={collapsed}
  aria-label={ariaLabel || t(M['ui.tenant_nav.tenant_navigation'])} data-smrt-component="TenantNav"
>

  {@render navItems(items)}
  {#each groups as group (groupId(group))}
    {#if navMode === 'sections' || navMode === 'sections-with-items'}
      {@const href = groupHref(group)}
      {#if href}
        <div class="smrt-tenant-nav__section" data-nav-section={groupId(group)} in:fly={reveal()}>
          <div class="smrt-tenant-nav__row">
            <a
              {href}
              class="smrt-tenant-nav__section-link"
              class:smrt-tenant-nav__link--visible-active={isSectionCurrent(group)}
              aria-current={href === currentHref ? 'page' : isSectionCurrent(group) ? 'true' : undefined}
              title={collapsed ? group.heading : undefined}
              onclick={onNavigate}
            >
              <span class="smrt-tenant-nav__icon" aria-hidden="true">
                <ShellSectionIcon
                  name={group.icon ?? SHELL_DEFAULT_SECTION_ICON}
                  size={18}
                  iconComponent={IconComponent}
                />
              </span>
              {#if collapsed}
                <span class="smrt-tenant-nav__sr-only">{group.heading}</span>
              {:else}
                <strong>{group.heading}</strong>
              {/if}
            </a>
          </div>
          {#if navMode === 'sections-with-items' && !collapsed && group.items.length}
            <div class="smrt-tenant-nav__subnav">
              {@render navItems(group.items, isGroupCurrent(group))}
            </div>
          {/if}
        </div>
      {/if}
    {:else if group.showTitle === false}
      <div class="smrt-tenant-nav__group smrt-tenant-nav__group--flat" role="group" aria-label={group.heading}>
        <div class="smrt-tenant-nav__group-items">{@render navItems(group.items, isGroupCurrent(group))}</div>
      </div>
    {:else}
    <details class="smrt-tenant-nav__group" aria-label={group.heading} open>
      <summary class="smrt-tenant-nav__heading">
        {#if collapsed}
          <span aria-hidden="true">{fallbackIcon(group.heading)}</span>
          <span class="smrt-tenant-nav__sr-only">{group.heading}</span>
        {:else}
          <span>{group.heading}</span>
        {/if}
      </summary>
      <div class="smrt-tenant-nav__group-items">{@render navItems(group.items, isGroupCurrent(group))}</div>
    </details>
    {/if}
  {/each}
</nav>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-tenant-nav,
  .smrt-tenant-nav__section,
  .smrt-tenant-nav__children,
  .smrt-tenant-nav__group-items {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .smrt-tenant-nav__row {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    min-inline-size: 0;
  }
  .smrt-tenant-nav__row > a:first-child { flex: 1 1 auto; min-inline-size: 0; }
  .smrt-tenant-nav a.smrt-tenant-nav__action {
    flex: 0 0 auto;
    display: inline-grid;
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    inline-size: max(2rem, var(--smrt-control-target-min));
    block-size: max(2rem, var(--smrt-control-target-min));
    padding: 0;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-tenant-nav a.smrt-tenant-nav__action:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }

  .smrt-tenant-nav__heading {
    box-sizing: border-box;
    min-block-size: var(--smrt-control-target-min);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size);
    font-weight: var(--smrt-typography-weight-semibold);
    border-radius: var(--smrt-control-radius);
    cursor: pointer;
  }
  .smrt-tenant-nav__heading:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-tenant-nav__group-items { margin-block-start: var(--smrt-spacing-1); }
  .smrt-tenant-nav__subnav {
    display: grid;
    gap: var(--smrt-spacing-1);
    padding-inline-start: var(--smrt-spacing-4);
  }
  .smrt-tenant-nav--collapsed .smrt-tenant-nav__heading {
    display: grid;
    place-items: center;
    list-style: none;
    inline-size: max(2.25rem, var(--smrt-control-target-min));
    block-size: max(2.25rem, var(--smrt-control-target-min));
    padding: 0;
  }
  .smrt-tenant-nav--collapsed .smrt-tenant-nav__heading::-webkit-details-marker { display: none; }

  /* Phone rows use the touch target; comfortable density opts back out. */
  @media (max-width: 48rem) {
    .smrt-tenant-nav { --smrt-control-target-min: var(--smrt-touch-target-min); }
  }
  .smrt-tenant-nav[data-density='touch'] { --smrt-control-target-min: var(--smrt-touch-target-min); }
  .smrt-tenant-nav[data-density='comfortable'] { --smrt-control-target-min: 0px; }
  .smrt-tenant-nav a {
    box-sizing: border-box;
    min-block-size: var(--smrt-control-target-min);
    display: grid;
    /* Icon, label, then one auto column per trailing mark (badge, dot). */
    grid-template-columns: auto minmax(0, 1fr);
    grid-auto-flow: column;
    grid-auto-columns: auto;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-radius: var(--smrt-control-radius);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }

  .smrt-tenant-nav--collapsed,
  .smrt-tenant-nav--collapsed .smrt-tenant-nav__section {
    justify-items: center;
  }

  .smrt-tenant-nav--collapsed a {
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    inline-size: max(2.25rem, var(--smrt-control-target-min));
    block-size: max(2.25rem, var(--smrt-control-target-min));
    padding: 0;
  }

  /* One state layer for every row: a currentColor veil driven by the
     theme's hover / pressed tokens. The selected container fill and the
     start indicator below sit under it, so hover still reads on a selected
     row. */
  .smrt-tenant-nav a::after,
  .smrt-tenant-nav__heading::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    pointer-events: none;
  }
  .smrt-tenant-nav__heading { position: relative; }
  .smrt-tenant-nav a:hover::after,
  .smrt-tenant-nav__heading:hover::after {
    opacity: var(--smrt-state-hover);
  }
  .smrt-tenant-nav a:active::after,
  .smrt-tenant-nav__heading:active::after {
    opacity: var(--smrt-state-pressed);
  }
  .smrt-tenant-nav a[aria-disabled='true'] {
    opacity: var(--smrt-state-disabled);
    pointer-events: none;
  }
  /* Selected: container fill plus a start indicator bar, not just weight. */
  .smrt-tenant-nav a[aria-current='page'],
  .smrt-tenant-nav a.smrt-tenant-nav__link--visible-active {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-tenant-nav a[aria-current='page']::before,
  .smrt-tenant-nav a.smrt-tenant-nav__link--visible-active::before {
    content: '';
    position: absolute;
    inset-block: var(--smrt-spacing-2);
    inset-inline-start: 0;
    inline-size: var(--smrt-spacing-1);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
  }
  .smrt-tenant-nav a[aria-current='page'] small,
  .smrt-tenant-nav a.smrt-tenant-nav__link--visible-active small {
    color: inherit;
  }

  .smrt-tenant-nav__icon {
    display: inline-grid;
    place-items: center;
    inline-size: 1.25rem;
    block-size: 1.25rem;
    min-inline-size: 1.25rem;
  }

  .smrt-tenant-nav__icon--placeholder {
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-tenant-nav strong,
  .smrt-tenant-nav span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-tenant-nav small {
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-tenant-nav__children {
    padding-inline-start: var(--smrt-spacing-4);
  }

  .smrt-tenant-nav a {
    position: relative;
  }

  .smrt-tenant-nav__attention {
    inline-size: 0.5rem;
    block-size: 0.5rem;
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-error);
    justify-self: end;
  }

  /* Collapsed: the dot sits on the icon's corner. */
  .smrt-tenant-nav--collapsed .smrt-tenant-nav__attention {
    position: absolute;
    inset-block-start: 0.125rem;
    inset-inline-end: 0.125rem;
    box-shadow: 0 0 0 var(--smrt-focus-ring-width) var(--smrt-surface-panel);
  }

  .smrt-tenant-nav__sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  /* Forced colors (#3908): selected and open states keep a non-colour indicator. */
  @media (forced-colors: active) {
    .smrt-tenant-nav a[aria-current='page'],
    .smrt-tenant-nav a.smrt-tenant-nav__link--visible-active { background: Canvas; color: CanvasText; font-weight: var(--smrt-typography-weight-bold); }
    .smrt-tenant-nav a[aria-current='page']::before,
    .smrt-tenant-nav a.smrt-tenant-nav__link--visible-active::before { background: Highlight; }
    .smrt-tenant-nav a[aria-disabled='true'] { opacity: 1; color: GrayText; }
  }
}
</style>
