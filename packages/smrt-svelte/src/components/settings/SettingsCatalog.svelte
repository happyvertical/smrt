<script lang="ts" generics="T extends SettingsCatalogItem, D extends { id: string } = T">
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.settings.js';
import type { SettingsCatalogItem, SettingsCatalogPage } from './types.js';

interface Props<T extends SettingsCatalogItem, D extends { id: string }> {
  /** Paginated catalog data with items, current page, and totals. */
  page: SettingsCatalogPage<T, D>;
  /** Base URL for navigation and search links. */
  baseUrl: string;
  /** Render snippet for the detail pane, receives the selected item. */
  detail: Snippet<[{ item: D }]>;
  /** Placeholder text for the search input field. */
  searchPlaceholder?: string;
  /** Label for the search input field. */
  searchLabel?: string;
  /** Label for the results list navigation. */
  resultsLabel?: string;
  /** Text shown when there are no search results. */
  emptyLabel?: string;
  /** Text shown when no item is selected. */
  selectionLabel?: string;
  /** URL search parameters to preserve across pagination. */
  preservedParams?: Record<string, string>;
}

let {
  page,
  baseUrl,
  detail,
  searchPlaceholder,
  searchLabel,
  resultsLabel,
  emptyLabel,
  selectionLabel,
  preservedParams = {},
}: Props<T, D> = $props();

const { t } = useI18n();
const totalPages = $derived(Math.max(1, Math.ceil(page.total / page.pageSize)));
const rangeStart = $derived(
  page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1,
);
const rangeEnd = $derived(Math.min(page.total, page.page * page.pageSize));

function catalogHref(targetPage: number, selectedId?: string): string {
  const params = new URLSearchParams(preservedParams);
  if (page.query) params.set('q', page.query);
  if (targetPage > 1) params.set('page', String(targetPage));
  if (selectedId) params.set('selected', selectedId);
  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}
</script>

<section class="smrt-settings-catalog__root" data-smrt-component="SettingsCatalog">
  <aside class="smrt-settings-catalog__browser" data-smrt-part="group">
    <Form method="GET" action={baseUrl} preventDefault={false} class="smrt-settings-catalog__search" role="search">
      {#each Object.entries(preservedParams) as [name, value] (name)}
        <Input type="hidden" {name} {value} />
      {/each}
      <label for="smrt-settings-catalog-query" class="smrt-settings-catalog__sr-only" data-smrt-part="label">
        {searchLabel ?? t(M['ui.settings_catalog.search'])}
      </label>
      <Input
        id="smrt-settings-catalog-query"
        type="search"
        name="q"
        value={page.query}
        placeholder={searchPlaceholder ?? t(M['ui.settings_catalog.search'])}
      />
      <Button type="submit" size="sm">
        {t(M['ui.settings_catalog.search_action'])}
      </Button>
    </Form>

    <div class="smrt-settings-catalog__summary" data-smrt-part="meta">
      <span>
        {t(M['ui.settings_catalog.result_range'], {
          start: rangeStart,
          end: rangeEnd,
          total: page.total,
        })}
      </span>
    </div>

    <nav
      class="smrt-settings-catalog__results"
      aria-label={resultsLabel ?? t(M['ui.settings_catalog.results'])}
      data-smrt-part="list"
    >
      {#each page.items as item (item.id)}
        <a
          href={catalogHref(page.page, item.id)}
          class:smrt-settings-catalog__result--active={page.selected?.id === item.id}
          aria-current={page.selected?.id === item.id ? 'true' : undefined}
          data-smrt-part="row"
        >
          {#if item.eyebrow}
            <small>{item.eyebrow}</small>
          {/if}
          <strong>{item.label}</strong>
          {#if item.description}
            <span>{item.description}</span>
          {/if}
          {#if item.status}
            <span class="smrt-settings-catalog__status" data-smrt-part="status">{item.status}</span>
          {/if}
        </a>
      {:else}
        <p class="smrt-settings-catalog__empty" data-smrt-part="empty">
          {emptyLabel ?? t(M['ui.settings_catalog.no_results'])}
        </p>
      {/each}
    </nav>

    {#if totalPages > 1}
      <nav
        class="smrt-settings-catalog__pager"
        aria-label={t(M['ui.settings_catalog.pagination'])}
        data-smrt-part="footer"
      >
        {#if page.page > 1}
          <Button href={catalogHref(page.page - 1)} variant="ghost" size="sm">
            {t(M['ui.settings_catalog.previous'])}
          </Button>
        {:else}
          <span></span>
        {/if}
        <span>{page.page} / {totalPages}</span>
        {#if page.page < totalPages}
          <Button href={catalogHref(page.page + 1)} variant="ghost" size="sm">
            {t(M['ui.settings_catalog.next'])}
          </Button>
        {:else}
          <span></span>
        {/if}
      </nav>
    {/if}
  </aside>

  <div class="smrt-settings-catalog__detail" data-smrt-part="body">
    {#if page.selected}
      {@render detail({ item: page.selected })}
    {:else}
      <p>{selectionLabel ?? t(M['ui.settings_catalog.select_item'])}</p>
    {/if}
  </div>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-settings-catalog__root {
    display: grid;
    grid-template-columns: minmax(17rem, 22rem) minmax(0, 1fr);
    gap: var(--smrt-spacing-5);
    align-items: start;
    min-width: 0;
  }
  :global(.smrt-settings-catalog__search) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--smrt-spacing-2);
    align-items: center;
  }
  .smrt-settings-catalog__browser,
  .smrt-settings-catalog__detail {
    min-width: 0;
  }
  .smrt-settings-catalog__browser {
    position: sticky;
    top: var(--smrt-spacing-4);
    display: grid;
    gap: var(--smrt-spacing-3);
  }
  .smrt-settings-catalog__results {
    display: grid;
    max-block-size: min(42rem, calc(100vh - 19rem));
    overflow-y: auto;
  }
  .smrt-settings-catalog__results a {
    position: relative;
    display: grid;
    gap: var(--smrt-spacing-1);
    min-width: 0;
    padding: var(--smrt-spacing-3);
  }
  .smrt-settings-catalog__results a.smrt-settings-catalog__result--active::before {
    position: absolute;
    inset-block: var(--smrt-spacing-2);
    inset-inline-start: 0;
    inline-size: 3px;
    content: '';
  }
  .smrt-settings-catalog__results small,
  .smrt-settings-catalog__results span,
  .smrt-settings-catalog__results .smrt-settings-catalog__status {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-settings-catalog__results strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-settings-catalog__empty,
  .smrt-settings-catalog__detail > p {
    margin: 0;
  }
  .smrt-settings-catalog__empty {
    padding: var(--smrt-spacing-4) var(--smrt-spacing-3);
  }
  .smrt-settings-catalog__pager {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--smrt-spacing-2);
  }
  .smrt-settings-catalog__pager :global(a:last-child) {
    justify-self: end;
  }
  .smrt-settings-catalog__detail {
    padding: var(--smrt-spacing-4);
  }
  .smrt-settings-catalog__sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  @media (max-width: 760px) {
    .smrt-settings-catalog__root {
      grid-template-columns: minmax(0, 1fr);
    }
    .smrt-settings-catalog__browser {
      position: static;
    }
    .smrt-settings-catalog__results {
      max-block-size: 18rem;
    }
  }
}

@layer smrt.theme {
  .smrt-settings-catalog__summary {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
  }
  .smrt-settings-catalog__results {
    border-block: var(--smrt-hairline);
  }
  .smrt-settings-catalog__results a {
    border-bottom: var(--smrt-hairline);
    color: inherit;
    text-decoration: none;
  }
  .smrt-settings-catalog__results a:hover,
  .smrt-settings-catalog__results a.smrt-settings-catalog__result--active {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-settings-catalog__results a.smrt-settings-catalog__result--active::before {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
  }
  .smrt-settings-catalog__results small,
  .smrt-settings-catalog__results span,
  .smrt-settings-catalog__results .smrt-settings-catalog__status {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
  }
  .smrt-settings-catalog__results .smrt-settings-catalog__status {
    color: var(--smrt-color-primary);
  }
  .smrt-settings-catalog__empty,
  .smrt-settings-catalog__detail > p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-settings-catalog__pager {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
  }
  .smrt-settings-catalog__detail {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface);
  }
  .smrt-settings-catalog__sr-only {
    border: 0;
  }
}

</style>
