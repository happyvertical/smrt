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
 *   `data-shell-page-title`: on phones AdminShell hides crumbs only when its
 *   top bar declares `data-shell-page-navigation-replacement`, and visually
 *   hides the title only with `data-shell-page-title-replacement`.
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

<header class="smrt-page-header__root" data-page-header data-smrt-component="PageHeader">
  {#if trail.length > 0}
    <nav class="smrt-page-header__crumbs" data-smrt-part="list" aria-label={crumbsLabel} data-shell-breadcrumbs>
      <ol>
        {#each trail as crumb, index (`${index}:${crumb.href}`)}
          <li><a href={crumb.href}>{crumb.label}</a></li>
        {/each}
      </ol>
    </nav>
  {/if}

  <div class="smrt-page-header__main" data-smrt-part="header">
    <div class="smrt-page-header__content" data-smrt-part="body">
      {#if backHref}
        <a href={backHref} class="smrt-page-header__back-link" data-smrt-part="trigger" use:ripple>
          <Icon name="chevron-left" size={20} />
          <span>{backLabel}</span>
        </a>
      {/if}
      {#if titleField}
        <h1 class="smrt-page-header__title smrt-page-header__title-field" data-smrt-part="title" data-page-title-field>
          {@render titleField()}
        </h1>
      {:else}
        <h1 class="smrt-page-header__title" data-smrt-part="title" data-shell-page-title>{title}</h1>
      {/if}
      {#if subtitle}
        <p class="smrt-page-header__subtitle" data-smrt-part="description">{subtitle}</p>
      {/if}
      {#if meta}
        <div class="smrt-page-header__meta" data-smrt-part="meta">{@render meta()}</div>
      {/if}
    </div>

    {#if actions}
      <div class="smrt-page-header__actions" data-smrt-part="actions">
        {@render actions()}
      </div>
    {/if}
  </div>

  {#if children}
    <div class="smrt-page-header__extra" data-smrt-part="body" data-page-header-extra>
      {@render children()}
    </div>
  {/if}
</header>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-page-header__root {
    margin-bottom: 1.5rem;
  }
  .smrt-page-header__crumbs {
    margin-bottom: var(--smrt-spacing-1);
  }
  .smrt-page-header__crumbs ol {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .smrt-page-header__crumbs li {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .smrt-page-header__crumbs li + li::before {
    margin-inline-end: 0.35rem;
  }
  .smrt-page-header__crumbs a {
    overflow-wrap: anywhere;
  }
  .smrt-page-header__main {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem 1.5rem;
    flex-wrap: wrap;
  }
  .smrt-page-header__content {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    flex: 1;
    min-width: min(100%, 200px);
  }
  .smrt-page-header__crumbs li + li::before {
    content: '/';
  }
  .smrt-page-header__back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    margin-bottom: 0.75rem;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2) var(--smrt-spacing-1) var(--smrt-spacing-1);
    margin-left: -4px;
  }
  .smrt-page-header__title {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .smrt-page-header__title-field {
    min-width: 0;
  }
  .smrt-page-header__subtitle {
    margin: 0;
  }
  .smrt-page-header__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-page-header__actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
    margin-inline-start: auto;
  }
  .smrt-page-header__extra {
    margin-top: 1rem;
  }
}

@layer smrt.theme {
  .smrt-page-header__crumbs {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
    font-size: 0.84rem;
  }
  .smrt-page-header__crumbs li + li::before {
    color: var(--smrt-color-outline);
  }
  .smrt-page-header__crumbs a {
    color: inherit;
    text-decoration: none;
  }
  .smrt-page-header__crumbs a:hover {
    color: var(--smrt-color-primary);
    text-decoration: underline;
  }
  .smrt-page-header__crumbs a:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-page-header__back-link {
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-large-font);
    text-decoration: none;
    border-radius: var(--smrt-radius-md);
    /* Align icon with text below */
    transition: background-color 200ms;
  }
  .smrt-page-header__back-link:hover {
    background-color: var(--smrt-color-surface-container-high);
  }
  .smrt-page-header__title {
    font: var(--smrt-typography-headline-medium-font);
    color: var(--smrt-color-on-surface);
    letter-spacing: -0.5px;
  }
  .smrt-page-header__subtitle {
    font: var(--smrt-typography-body-medium-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-page-header__meta {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
