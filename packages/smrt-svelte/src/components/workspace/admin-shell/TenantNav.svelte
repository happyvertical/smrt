<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Component } from 'svelte';
import { M } from '../../../i18n/strings.workspace.js';
import type { ShellNavItem } from './types.js';

interface Props {
  items: ShellNavItem[];
  currentHref?: string;
  iconComponent?: Component<{ name: string; size?: number }>;
  collapsed?: boolean;
  onNavigate?: () => void;
}

let {
  items,
  currentHref = '',
  iconComponent: IconComponent,
  collapsed = false,
  onNavigate,
}: Props = $props();
const { t } = useI18n();

function isActive(item: ShellNavItem): boolean {
  return item.href === currentHref || currentHref.startsWith(`${item.href}/`);
}

function isVisibleActive(item: ShellNavItem): boolean {
  if (isActive(item)) return true;
  return collapsed && !!item.children?.some((child) => isActive(child));
}

function fallbackIcon(label: string): string {
  return label.trim().charAt(0).toLocaleUpperCase() || '?';
}
</script>

<nav
  class="smrt-tenant-nav"
  class:smrt-tenant-nav--collapsed={collapsed}
  aria-label={t(M['ui.tenant_nav.tenant_navigation'])}
>
  {#each items as item (item.href)}
    <div class="smrt-tenant-nav__section">
      <a
        href={item.href}
        class:smrt-tenant-nav__link--visible-active={isVisibleActive(item)}
        aria-current={isActive(item) ? 'page' : undefined}
        title={collapsed ? item.label : item.description}
        onclick={onNavigate}
      >
        {#if item.icon}
          <span class="smrt-tenant-nav__icon" aria-hidden="true">
            {#if IconComponent}
              <IconComponent name={item.icon} size={18} />
            {:else}
              {item.icon}
            {/if}
          </span>
        {:else if collapsed}
          <span
            class="smrt-tenant-nav__icon smrt-tenant-nav__icon--fallback"
            aria-hidden="true"
          >
            {fallbackIcon(item.label)}
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
      </a>
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
                  {#if IconComponent}
                    <IconComponent name={child.icon} size={16} />
                  {:else}
                    {child.icon}
                  {/if}
                </span>
              {/if}
              <span>{child.label}</span>
              {#if child.badge !== null && child.badge !== undefined}
                <small>{child.badge}</small>
              {/if}
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>

<style>
  .smrt-tenant-nav,
  .smrt-tenant-nav__section,
  .smrt-tenant-nav__children {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .smrt-tenant-nav a {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--smrt-spacing-2);
    min-inline-size: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-medium);
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
    inline-size: 2.25rem;
    block-size: 2.25rem;
    padding: 0;
  }

  .smrt-tenant-nav a:hover,
  .smrt-tenant-nav a[aria-current='page'],
  .smrt-tenant-nav a.smrt-tenant-nav__link--visible-active {
    background: var(--smrt-color-surface-container-high);
  }

  .smrt-tenant-nav__icon {
    display: inline-grid;
    place-items: center;
    inline-size: 1.25rem;
    block-size: 1.25rem;
    min-inline-size: 1.25rem;
  }

  .smrt-tenant-nav__icon--fallback {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size);
    font-weight: var(--smrt-typography-weight-semibold);
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
</style>
