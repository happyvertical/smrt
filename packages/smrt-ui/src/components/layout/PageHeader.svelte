<script lang="ts">
/**
 * PageHeader - one header per page: an ancestors-only breadcrumb row, the
 * page title (`<h1>`), and the page's own actions, right-aligned.
 *
 * Page-header contract (shared with AdminShell in smrt-svelte/workspace):
 * - `crumbs` are the page's ancestors only, never the page itself; none on
 *   section homes. Inside a shell that sets `setPageHeaderContext()`, pages
 *   pass only `parents` (ancestors the nav doesn't know, e.g. the article
 *   above its video) and the shell adds the rest; the shell also hears the
 *   title (for its phone top bar). smrt-svelte's `shellPageTrailFor()`
 *   computes such a trail from a nav.
 * - The crumb row carries `data-shell-breadcrumbs` and the title
 *   `data-shell-page-title`: on phones AdminShell hides the crumbs and
 *   visually hides the title, because its phone top bar shows the back arrow
 *   and the title instead.
 * - No in-page back link: the crumbs (and the phone top bar) are the way
 *   back. `backHref` is kept only for pages outside such a shell.
 * - An editable title (`titleField`, e.g. an article's headline) renders
 *   inside the `<h1>`, so the heading is still the page's title in the
 *   outline and is named by the field's value, while the field keeps its own
 *   label. Such a heading has no `data-shell-page-title`: it stays visible on
 *   phones, because it is the input. Pass the live value as `title` so the
 *   shell (the phone top bar) follows along as the person types.
 */
import type { Snippet } from 'svelte';
import { ripple } from '../../actions/ripple.js';
import { Icon } from '../display/index.js';
import {
  getPageHeaderContext,
  type PageHeaderCrumb,
} from './page-header-context.js';

export interface Props {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string;
  /**
   * All ancestors of this page, outermost first (never the page itself).
   * Overrides the shell's trail; usually pass `parents` instead.
   */
  crumbs?: readonly PageHeaderCrumb[];
  /** Ancestors past the shell's nav, outermost first. */
  parents?: readonly PageHeaderCrumb[];
  /** Shorter title for the shell (e.g. its phone top bar); default `title`. */
  shortTitle?: string;
  /** Accessible name of the breadcrumb nav. */
  crumbsLabel?: string;
  /**
   * Back navigation URL.
   * @deprecated Use `crumbs`; inside AdminShell the phone top bar goes back.
   */
  backHref?: string;
  /** Back link label */
  backLabel?: string;
  /**
   * An editable title rendered inside the `<h1>` in place of `title`'s text
   * (a labelled text field styled as the heading). `title` still names the
   * page for the shell; keep it in sync with the field's value.
   */
  titleField?: Snippet;
  /** Slot for action buttons (right-aligned beside the title) */
  actions?: Snippet;
  /** Small line under the title (status, dates, counts) */
  meta?: Snippet;
  /** Slot for additional content below the title row (e.g. page tabs) */
  children?: Snippet;
}

const {
  title,
  subtitle,
  crumbs,
  parents = [],
  shortTitle,
  crumbsLabel = 'Breadcrumb',
  backHref,
  backLabel = 'Back',
  titleField,
  actions,
  meta,
  children,
}: Props = $props();

const shell = getPageHeaderContext();
const trail = $derived<readonly PageHeaderCrumb[]>(
  crumbs ?? (shell ? shell.crumbs(parents) : parents),
);

$effect(() => shell?.report?.({ title: shortTitle ?? title, parents }));
</script>

<header class="page-header" data-page-header>
  {#if trail.length > 0}
    <nav class="page-crumbs" aria-label={crumbsLabel} data-shell-breadcrumbs>
      <ol>
        {#each trail as crumb, index (`${index}:${crumb.href}`)}
          <li><a href={crumb.href}>{crumb.label}</a></li>
        {/each}
      </ol>
    </nav>
  {/if}

  <div class="header-main">
    <div class="header-content">
      {#if backHref}
        <a href={backHref} class="back-link" use:ripple>
          <Icon name="chevron-left" size={20} />
          <span>{backLabel}</span>
        </a>
      {/if}
      {#if titleField}
        <h1 class="page-title page-title-field" data-page-title-field>
          {@render titleField()}
        </h1>
      {:else}
        <h1 class="page-title" data-shell-page-title>{title}</h1>
      {/if}
      {#if subtitle}
        <p class="page-subtitle">{subtitle}</p>
      {/if}
      {#if meta}
        <div class="page-meta">{@render meta()}</div>
      {/if}
    </div>

    {#if actions}
      <div class="header-actions">
        {@render actions()}
      </div>
    {/if}
  </div>

  {#if children}
    <div class="header-extra" data-page-header-extra>
      {@render children()}
    </div>
  {/if}
</header>

<style>
  .page-header {
    margin-bottom: 1.5rem;
  }

  .page-crumbs {
    margin-bottom: var(--smrt-spacing-1, 4px);
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
    font-size: 0.84rem;
  }

  .page-crumbs ol {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .page-crumbs li {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .page-crumbs li + li::before {
    content: '/';
    margin-inline-end: 0.35rem;
    color: var(--smrt-color-outline);
  }

  .page-crumbs a {
    color: inherit;
    text-decoration: none;
    overflow-wrap: anywhere;
  }

  .page-crumbs a:hover {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }

  .page-crumbs a:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
    border-radius: var(--smrt-radius-sm, 4px);
  }

  .header-main {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem 1.5rem;
    flex-wrap: wrap;
  }

  .header-content {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    flex: 1;
    min-width: min(100%, 200px);
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 4px);
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-large-font);
    text-decoration: none;
    margin-bottom: 0.75rem;
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px) var(--smrt-spacing-1, 4px) var(--smrt-spacing-1, 4px);
    border-radius: var(--smrt-radius-md, 8px);
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
    overflow-wrap: anywhere;
  }

  .page-title-field {
    min-width: 0;
  }

  .page-subtitle {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
    margin: 0;
  }

  .page-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }

  .header-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
    margin-inline-start: auto;
  }

  .header-extra {
    margin-top: 1rem;
  }
</style>
