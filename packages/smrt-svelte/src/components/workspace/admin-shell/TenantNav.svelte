<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.workspace.js';
import type { ShellNavItem } from './types.js';

interface Props {
  items: ShellNavItem[];
  currentHref?: string;
  onNavigate?: () => void;
}

let { items, currentHref = '', onNavigate }: Props = $props();
const { t } = useI18n();

function isActive(item: ShellNavItem): boolean {
  return item.href === currentHref || currentHref.startsWith(`${item.href}/`);
}
</script>

<nav
  class="smrt-tenant-nav"
  aria-label={t(M['ui.tenant_nav.tenant_navigation'])}
>
  {#each items as item (item.href)}
    <div class="smrt-tenant-nav__section">
      <a
        href={item.href}
        aria-current={isActive(item) ? 'page' : undefined}
        onclick={onNavigate}
      >
        {#if item.icon}
          <span aria-hidden="true">{item.icon}</span>
        {/if}
        <strong>{item.label}</strong>
        {#if item.badge !== null && item.badge !== undefined}
          <small>{item.badge}</small>
        {/if}
      </a>
      {#if item.children?.length}
        <div class="smrt-tenant-nav__children">
          {#each item.children as child (child.href)}
            <a
              href={child.href}
              aria-current={isActive(child) ? 'page' : undefined}
              onclick={onNavigate}
            >
              {#if child.icon}
                <span aria-hidden="true">{child.icon}</span>
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

  .smrt-tenant-nav a:hover,
  .smrt-tenant-nav a[aria-current='page'] {
    background: var(--smrt-color-surface-container-high);
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
</style>
