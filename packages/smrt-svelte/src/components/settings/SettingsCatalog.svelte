<script lang="ts" generics="T extends SettingsCatalogItem, D extends { id: string } = T">
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.settings.js';
import type { SettingsCatalogItem, SettingsCatalogPage } from './types.js';

interface Props<T extends SettingsCatalogItem, D extends { id: string }> {
  page: SettingsCatalogPage<T, D>;
  baseUrl: string;
  detail: Snippet<[{ item: D }]>;
  searchPlaceholder?: string;
  searchLabel?: string;
  resultsLabel?: string;
  emptyLabel?: string;
  selectionLabel?: string;
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

<section class="smrt-settings-catalog">
  <aside class="smrt-settings-catalog__browser">
    <Form method="GET" action={baseUrl} preventDefault={false} class="smrt-settings-catalog__search" role="search">
      {#each Object.entries(preservedParams) as [name, value] (name)}
        <Input type="hidden" {name} {value} />
      {/each}
      <label for="smrt-settings-catalog-query" class="smrt-settings-catalog__sr-only">
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

    <div class="smrt-settings-catalog__summary">
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
    >
      {#each page.items as item (item.id)}
        <a
          href={catalogHref(page.page, item.id)}
          class:smrt-settings-catalog__result--active={page.selected?.id === item.id}
          aria-current={page.selected?.id === item.id ? 'true' : undefined}
        >
          {#if item.eyebrow}
            <small>{item.eyebrow}</small>
          {/if}
          <strong>{item.label}</strong>
          {#if item.description}
            <span>{item.description}</span>
          {/if}
          {#if item.status}
            <span class="smrt-settings-catalog__status">{item.status}</span>
          {/if}
        </a>
      {:else}
        <p class="smrt-settings-catalog__empty">
          {emptyLabel ?? t(M['ui.settings_catalog.no_results'])}
        </p>
      {/each}
    </nav>

    {#if totalPages > 1}
      <nav
        class="smrt-settings-catalog__pager"
        aria-label={t(M['ui.settings_catalog.pagination'])}
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

  <div class="smrt-settings-catalog__detail">
    {#if page.selected}
      {@render detail({ item: page.selected })}
    {:else}
      <p>{selectionLabel ?? t(M['ui.settings_catalog.select_item'])}</p>
    {/if}
  </div>
</section>

<style>
  .smrt-settings-catalog {
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

  .smrt-settings-catalog__summary {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
  }

  .smrt-settings-catalog__results {
    display: grid;
    max-block-size: min(42rem, calc(100vh - 19rem));
    overflow-y: auto;
    border-block: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-settings-catalog__results a {
    position: relative;
    display: grid;
    gap: var(--smrt-spacing-1);
    min-width: 0;
    padding: var(--smrt-spacing-3);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    color: inherit;
    text-decoration: none;
  }

  .smrt-settings-catalog__results a:hover,
  .smrt-settings-catalog__results a.smrt-settings-catalog__result--active {
    background: var(--smrt-color-surface-container-high);
  }

  .smrt-settings-catalog__results a.smrt-settings-catalog__result--active::before {
    position: absolute;
    inset-block: var(--smrt-spacing-2);
    inset-inline-start: 0;
    inline-size: 3px;
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
    content: '';
  }

  .smrt-settings-catalog__results small,
  .smrt-settings-catalog__results span,
  .smrt-settings-catalog__results .smrt-settings-catalog__status {
    overflow: hidden;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-settings-catalog__results strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-settings-catalog__results .smrt-settings-catalog__status {
    color: var(--smrt-color-primary);
  }

  .smrt-settings-catalog__empty,
  .smrt-settings-catalog__detail > p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-settings-catalog__empty {
    padding: var(--smrt-spacing-4) var(--smrt-spacing-3);
  }

  .smrt-settings-catalog__pager {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--smrt-spacing-2);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size);
  }

  .smrt-settings-catalog__pager :global(a:last-child) {
    justify-self: end;
  }

  .smrt-settings-catalog__detail {
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface);
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
    border: 0;
  }

  @media (max-width: 760px) {
    .smrt-settings-catalog {
      grid-template-columns: minmax(0, 1fr);
    }

    .smrt-settings-catalog__browser {
      position: static;
    }

    .smrt-settings-catalog__results {
      max-block-size: 18rem;
    }
  }
</style>
