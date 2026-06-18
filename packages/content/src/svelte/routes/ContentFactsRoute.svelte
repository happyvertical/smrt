<script lang="ts">
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { onMount } from 'svelte';
import { createClient, type FactData } from '../../mock-smrt-client.js';
import { M } from '../i18n.routes.js';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
} from './shared.js';

interface ContentFactsRouteProps {
  navigation?: ContentRouteNavigationItem[];
  apiBaseUrl?: string;
  createHref?: string | null;
  embedded?: boolean;
}

let {
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
  apiBaseUrl = '/api/v1',
  createHref = null,
  embedded = false,
}: ContentFactsRouteProps = $props();

const client = $derived(createClient(apiBaseUrl));
const { t } = useI18n();

let query = $state('');
let latestOnly = $state(true);
let includeSuperseded = $state(false);
let facts = $state<FactData[]>([]);
let loading = $state(true);
let refreshing = $state(false);
let error = $state<string | null>(null);

function formatConfidence(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function metadataEntries(fact: FactData) {
  return Object.entries(fact.metadata ?? {}).slice(0, 4);
}

async function loadFacts() {
  error = null;
  refreshing = true;

  try {
    const response = await client.contents.browseFacts(query, {
      limit: 100,
      latestOnly,
      includeSuperseded,
    });
    facts = response.data;
  } catch (err: any) {
    error = err.message || 'Failed to load facts.';
  } finally {
    loading = false;
    refreshing = false;
  }
}

function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  void loadFacts();
}

onMount(() => {
  void loadFacts();
});
</script>

<div class:page={true} class:page--embedded={embedded}>
  <header class="page-header">
    <div class="container">
      <div class="page-header__copy">
        <div class="eyebrow">{t(M['content.facts.eyebrow'])}</div>
        <h1>{t(M['content.facts.heading'])}</h1>
        <p>
          {t(M['content.facts.intro'])}
        </p>
      </div>

      <div class="page-header__actions">
        <nav class="page-nav" aria-label={t(M['content.facts.nav_aria'])}>
          {#each navigation as item (item.routeId)}
            <a
              href={item.href}
              aria-current={item.routeId === CONTENT_ROUTE_IDS.facts
                ? 'page'
                : undefined}
            >
              {item.label}
            </a>
          {/each}
        </nav>

        {#if createHref}
          <a class="page-cta" href={createHref}>{t(M['content.facts.create_cta'])}</a>
        {/if}
      </div>
    </div>
  </header>

  <main class="container page-main">
    <section class="filters-panel">
      <form class="filters" onsubmit={handleSubmit}>
        <label class="search-field">
          <span>Search</span>
          <input
            type="search"
            bind:value={query}
            placeholder={t(M['content.facts.search_placeholder'])}
          />
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            bind:checked={latestOnly}
            onchange={() => void loadFacts()}
          />
          <span>{t(M['content.facts.latest_only'])}</span>
        </label>

        <label class="toggle">
          <input
            type="checkbox"
            bind:checked={includeSuperseded}
            onchange={() => void loadFacts()}
          />
          <span>{t(M['content.facts.include_superseded'])}</span>
        </label>

        <button class="refresh-button" type="submit" disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </form>
    </section>

    {#if error}
      <section class="panel panel--error">
        <strong>Error</strong>
        <p>{error}</p>
      </section>
    {:else if loading}
      <section class="panel empty-state">
        <p>{t(M['content.facts.loading'])}</p>
      </section>
    {:else if facts.length === 0}
      <section class="panel empty-state">
        <h2>{t(M['content.facts.empty_title'])}</h2>
        <p>
          {t(M['content.facts.empty_body'])}
        </p>
      </section>
    {:else}
      <section class="panel results-panel">
        <div class="results-meta">
          <div>
            <strong>{facts.length}</strong>
            <span>{facts.length === 1 ? 'fact loaded' : 'facts loaded'}</span>
          </div>
          <div class="results-hints">
            <span>{latestOnly ? 'Latest versions' : 'All versions'}</span>
            <span>{includeSuperseded ? 'Superseded included' : 'Superseded hidden'}</span>
          </div>
        </div>

        <div class="facts-list">
          {#each facts as fact (fact.id ?? `${fact.textRefined}-${fact.createdAt}`)}
            <article class="fact-row">
              <div class="fact-row__header">
                <div class="fact-row__badges">
                  {#if fact.status}
                    <span class="badge">{fact.status}</span>
                  {/if}
                  {#if fact.domain}
                    <span class="badge badge--neutral">{fact.domain}</span>
                  {/if}
                </div>

                <div class="fact-row__stats">
                  <span>Confidence {formatConfidence(fact.confidence)}</span>
                  <span>Sources {fact.sourceCount ?? 0}</span>
                  <span>{formatDate(fact.updatedAt || fact.createdAt)}</span>
                </div>
              </div>

              <h2>{fact.textRefined || fact.textRaw || 'Untitled fact'}</h2>

              {#if fact.textRaw && fact.textRefined && fact.textRaw !== fact.textRefined}
                <details>
                  <summary>{t(M['content.facts.raw_input'])}</summary>
                  <p>{fact.textRaw}</p>
                </details>
              {/if}

              {#if metadataEntries(fact).length > 0}
                <dl class="metadata-list">
                  {#each metadataEntries(fact) as [key, value]}
                    <div>
                      <dt>{key}</dt>
                      <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                    </div>
                  {/each}
                </dl>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {/if}
  </main>
</div>

<style>
  :global(body:has(.page:not(.page--embedded))) {
    margin: 0;
    font-family:
      var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont,
      'Segoe UI', Roboto, sans-serif);
    background:
      radial-gradient(
        circle at top,
        color-mix(in srgb, var(--smrt-color-primary) 10%, transparent),
        transparent 36%
      ),
      var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    min-height: 100vh;
  }

  .page {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
  }

  .page--embedded {
    min-height: auto;
    padding: 0;
  }

  .container {
    max-width: 1280px;
    margin: 0 auto;
  }

  .page-header {
    margin-bottom: 1.5rem;
  }

  .page-header .container {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .page-header__copy {
    max-width: 50rem;
  }

  .page-header__actions {
    display: grid;
    gap: 0.85rem;
    justify-items: end;
  }

  .eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .page-header h1 {
    margin: 0.35rem 0 0.65rem;
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }

  .page-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    max-width: 44rem;
  }

  .page-nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
  }

  .page-nav a,
  .page-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .page-nav a[aria-current='page'] {
    color: var(--smrt-color-primary);
    border-color: color-mix(
      in srgb,
      var(--smrt-color-primary) 28%,
      transparent
    );
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 10%,
      var(--smrt-color-surface)
    );
  }

  .page-cta {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-color: transparent;
  }

  .page-main {
    display: grid;
    gap: 1rem;
  }

  .filters-panel,
  .panel {
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 96%,
      transparent
    );
    border-radius: 1rem;
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
  }

  .filters-panel {
    padding: 1rem;
  }

  .panel {
    padding: 1.25rem;
  }

  .panel--error {
    border-color: color-mix(in srgb, var(--smrt-color-error) 30%, transparent);
  }

  .filters {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) repeat(2, auto) auto;
    gap: 0.75rem;
    align-items: end;
  }

  .search-field {
    display: grid;
    gap: 0.4rem;
  }

  .search-field span {
    font-size: var(--smrt-typography-label-large-size, 0.82rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
  }

  .search-field input {
    min-height: 2.85rem;
    border-radius: 0.85rem;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    padding: 0 0.95rem;
  }

  .toggle {
    min-height: 2.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0 0.9rem;
    border-radius: 0.85rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }

  .refresh-button {
    min-height: 2.85rem;
    border-radius: 0.85rem;
    border: none;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    padding: 0 1rem;
    font-weight: var(--smrt-typography-weight-bold, 700);
    cursor: pointer;
  }

  .results-panel {
    display: grid;
    gap: 1rem;
  }

  .results-meta {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .results-meta strong {
    font-size: var(--smrt-typography-title-large-size, 1.2rem);
    margin-right: 0.5rem;
  }

  .results-meta span {
    color: var(--smrt-color-on-surface-variant);
  }

  .results-hints {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .results-hints span {
    display: inline-flex;
    align-items: center;
    min-height: 1.9rem;
    padding: 0 0.7rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container-low);
    font-size: var(--smrt-typography-label-large-size, 0.82rem);
  }

  .facts-list {
    display: grid;
  }

  .fact-row {
    display: grid;
    gap: 0.9rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .fact-row:first-child {
    padding-top: 0;
  }

  .fact-row:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .fact-row__header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .fact-row__badges,
  .fact-row__stats {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .fact-row h2 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1.08rem);
    line-height: var(--smrt-typography-title-medium-line-height, 1.45);
    color: var(--smrt-color-on-surface);
  }

  .fact-row__stats span {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.84rem);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    min-height: 1.65rem;
    padding: 0 0.6rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 12%,
      transparent
    );
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }

  .badge--neutral {
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
  }

  details {
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 0.8rem;
  }

  details summary {
    cursor: pointer;
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
  }

  details p {
    margin: 0.75rem 0 0;
    color: var(--smrt-color-on-surface-variant);
    white-space: pre-wrap;
  }

  .metadata-list {
    display: flex;
    gap: 0.65rem;
    flex-wrap: wrap;
    margin: 0;
  }

  .metadata-list div {
    min-width: 10rem;
    max-width: 18rem;
    display: grid;
    gap: 0.15rem;
  }

  .metadata-list dt {
    font-size: var(--smrt-typography-label-medium-size, 0.72rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
  }

  .metadata-list dd {
    margin: 0;
    color: var(--smrt-color-on-surface);
    word-break: break-word;
  }

  .empty-state {
    text-align: center;
  }

  .empty-state h2,
  .empty-state p {
    margin: 0;
  }

  .empty-state p {
    color: var(--smrt-color-on-surface-variant);
  }

  @media (max-width: 840px) {
    .page-header__actions {
      width: 100%;
      justify-items: stretch;
    }

    .page-nav {
      justify-content: flex-start;
    }

    .filters {
      grid-template-columns: 1fr;
    }
  }
</style>
