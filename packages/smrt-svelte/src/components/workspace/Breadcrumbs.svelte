<script lang="ts">
/**
 * Breadcrumbs — generic breadcrumb trail primitive.
 *
 * Two modes:
 *
 *  - **Explicit**: pass `items` directly.
 *  - **Auto**: pass `nav` + `pathname` and the component will walk the
 *    pathname segments, matching against the nav tree for labels and
 *    falling back to capitalized segments otherwise. Use `rootCrumb`
 *    to prepend a site/section identity and `startAfter` to skip a
 *    pathname prefix (e.g. `'sites/foo'` to ignore the
 *    `/sites/foo` portion of a per-site path).
 *
 * SvelteKit-agnostic: no `$app/*` imports. Consumers supply the
 * pathname externally.
 */
import { deriveCrumbsFromNav } from './breadcrumbs-helpers.js';
import type { BreadcrumbItem, NavItem } from './types.js';

interface Props {
  /** Explicit crumbs. When provided, `nav` and `pathname` are ignored. */
  items?: BreadcrumbItem[];
  /** Nav tree to derive labels from in auto mode. */
  nav?: NavItem[];
  /** Pathname to walk in auto mode. */
  pathname?: string;
  /** Optional leading crumb (e.g. site name). Auto mode only. */
  rootCrumb?: BreadcrumbItem;
  /** Capitalize fallback labels for unknown segments. Default: true. */
  capitalize?: boolean;
  /** Skip pathname segments through this path (e.g. `'sites/foo'`). */
  startAfter?: string;
  /** Accessible label for the breadcrumb nav. */
  'aria-label'?: string;
}

const {
  items,
  nav,
  pathname,
  rootCrumb,
  capitalize = true,
  startAfter,
  'aria-label': ariaLabel = 'Breadcrumb',
}: Props = $props();

const crumbs = $derived.by((): BreadcrumbItem[] => {
  if (items) return items;
  if (!nav || pathname == null) {
    return rootCrumb ? [rootCrumb] : [];
  }
  return deriveCrumbsFromNav(pathname, nav, {
    rootCrumb,
    startAfter,
    capitalize,
  });
});

const lastIndex = $derived(crumbs.length - 1);
</script>

<nav class="smrt-breadcrumbs" aria-label={ariaLabel} data-smrt-component="Breadcrumbs">
  <ol class="smrt-breadcrumbs__crumb-list" data-smrt-part="list">
    {#each crumbs as crumb, i (`${i}:${crumb.href ?? crumb.label}`)}
      <li class="smrt-breadcrumbs__crumb-item" data-smrt-part="item">
        {#if i > 0}
          <span class="smrt-breadcrumbs__separator" aria-hidden="true" data-smrt-part="separator">/</span>
        {/if}
        {#if i === lastIndex || !crumb.href}
          <span
            class="smrt-breadcrumbs__current"
            aria-current={i === lastIndex ? 'page' : undefined} data-smrt-part="label"
            >{crumb.label}</span
          >
        {:else}
          <a href={crumb.href} class="smrt-breadcrumbs__crumb-link" data-smrt-part="link">{crumb.label}</a>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-breadcrumbs {
    width: 100%;
  }
  .smrt-breadcrumbs__crumb-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .smrt-breadcrumbs__crumb-item {
    display: inline-flex;
    align-items: center;
  }
  .smrt-breadcrumbs__separator {
    margin: 0 0.5rem;
  }
  @media (max-width: 640px) {
    .smrt-breadcrumbs__separator {
      margin: 0 0.35rem;
    }
  }
}

@layer smrt.theme {
  .smrt-breadcrumbs__crumb-item {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-breadcrumbs__separator {
    color: var(--smrt-color-outline-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
  }
  .smrt-breadcrumbs__current {
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface);
  }
  .smrt-breadcrumbs__crumb-link {
    color: var(--smrt-color-on-surface-variant);
    text-decoration: none;
    transition: color 0.15s ease;
  }
  .smrt-breadcrumbs__crumb-link:hover {
    color: var(--smrt-color-on-surface);
    text-decoration: underline;
  }
  .smrt-breadcrumbs__crumb-link:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
    border-radius: var(--smrt-radius-sm);
  }
  @media (max-width: 640px) {
    .smrt-breadcrumbs__crumb-item {
      font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    }
  }
}
</style>
