<script lang="ts">
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import { createClient, type FactData } from '../../mock-smrt-client.js';
import { M } from '../i18n.routes.js';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
} from './shared.js';

interface ContentFactsRouteProps {
  /** Pre-initialized API client; creates a new one if omitted. */
  client?: ReturnType<typeof createClient>;
  /** Navigation items shown in the sidebar. */
  navigation?: ContentRouteNavigationItem[];
  /** Base URL for fact API requests. */
  apiBaseUrl?: string;
  /** URL to navigate to when creating a new fact. */
  createHref?: string | null;
  /** Whether the route is embedded in a parent application. */
  embedded?: boolean;
}

let {
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
  apiBaseUrl = '/api/v1',
  createHref = null,
  embedded = false,
  client = undefined,
}: ContentFactsRouteProps = $props();

const apiClient = $derived(client ?? createClient(apiBaseUrl));
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
    const response = await apiClient.contents.browseFacts(query, {
      limit: 100,
      latestOnly,
      includeSuperseded,
    });
    facts = response.data;
  } catch (err) {
    error =
      (err instanceof Error ? err.message : '') || 'Failed to load facts.';
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

<div class="smrt-content-facts-route__root" class:smrt-content-facts-route__page--embedded={embedded} data-smrt-component="ContentFactsRoute">
  <header class="smrt-content-facts-route__header" data-smrt-part="header">
    <div class="smrt-content-facts-route__container" data-smrt-part="body">
      <div class="smrt-content-facts-route__header-copy" data-smrt-part="body">
        <div class="smrt-content-facts-route__eyebrow" data-smrt-part="label">{t(M['content.facts.eyebrow'])}</div>
        <h1>{t(M['content.facts.heading'])}</h1>
        <p>
          {t(M['content.facts.intro'])}
        </p>
      </div>

      <div class="smrt-content-facts-route__header-actions" data-smrt-part="actions">
        <nav class="smrt-content-facts-route__nav" data-smrt-part="nav" aria-label={t(M['content.facts.nav_aria'])}>
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
          <a class="smrt-content-facts-route__cta" data-smrt-part="submit" href={createHref}>{t(M['content.facts.create_cta'])}</a>
        {/if}
      </div>
    </div>
  </header>

  <main class="smrt-content-facts-route__container smrt-content-facts-route__main" data-smrt-part="body">
    <section class="smrt-content-facts-route__filters" data-smrt-part="filters">
      <Form class="filters" onsubmit={handleSubmit}>
        <label class="smrt-content-facts-route__search-field" data-smrt-part="search">
          <span>Search</span>
          <Input
            type="search"
            bind:value={query}
            placeholder={t(M['content.facts.search_placeholder'])}
          />
        </label>

        <label class="smrt-content-facts-route__toggle" data-smrt-part="trigger">
          <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
          <input
            type="checkbox"
            bind:checked={latestOnly}
            onchange={() => void loadFacts()}
          />
          <span>{t(M['content.facts.latest_only'])}</span>
        </label>

        <label class="smrt-content-facts-route__toggle" data-smrt-part="trigger">
          <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
          <input
            type="checkbox"
            bind:checked={includeSuperseded}
            onchange={() => void loadFacts()}
          />
          <span>{t(M['content.facts.include_superseded'])}</span>
        </label>

        <Button variant="primary" class="refresh-button" type="submit" disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </Form>
    </section>

    {#if error}
      <section class="smrt-content-facts-route__panel smrt-content-facts-route__panel--error" data-smrt-part="panel">
        <strong>Error</strong>
        <p>{error}</p>
      </section>
    {:else if loading}
      <section class="smrt-content-facts-route__panel smrt-content-facts-route__empty-state" data-smrt-part="empty">
        <p>{t(M['content.facts.loading'])}</p>
      </section>
    {:else if facts.length === 0}
      <section class="smrt-content-facts-route__panel smrt-content-facts-route__empty-state" data-smrt-part="empty">
        <h2>{t(M['content.facts.empty_title'])}</h2>
        <p>
          {t(M['content.facts.empty_body'])}
        </p>
      </section>
    {:else}
      <section class="smrt-content-facts-route__panel smrt-content-facts-route__results-panel" data-smrt-part="list">
        <div class="smrt-content-facts-route__results-meta" data-smrt-part="meta">
          <div>
            <strong>{facts.length}</strong>
            <span>{facts.length === 1 ? 'fact loaded' : 'facts loaded'}</span>
          </div>
          <div class="smrt-content-facts-route__results-hints" data-smrt-part="description">
            <span>{latestOnly ? 'Latest versions' : 'All versions'}</span>
            <span>{includeSuperseded ? 'Superseded included' : 'Superseded hidden'}</span>
          </div>
        </div>

        <div class="smrt-content-facts-route__facts-list" data-smrt-part="list">
          {#each facts as fact (fact.id ?? `${fact.textRefined}-${fact.createdAt}`)}
            <article class="smrt-content-facts-route__fact-row" data-smrt-part="row">
              <div class="smrt-content-facts-route__fact-row-header" data-smrt-part="header">
                <div class="smrt-content-facts-route__fact-row-badges" data-smrt-part="meta">
                  {#if fact.status}
                    <span class="smrt-content-facts-route__badge" data-smrt-part="badge">{fact.status}</span>
                  {/if}
                  {#if fact.domain}
                    <span class="smrt-content-facts-route__badge smrt-content-facts-route__badge--neutral" data-smrt-part="badge">{fact.domain}</span>
                  {/if}
                </div>

                <div class="smrt-content-facts-route__fact-row-stats" data-smrt-part="group">
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
                <dl class="smrt-content-facts-route__metadata-list" data-smrt-part="list">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  :global(body:has(.smrt-content-facts-route__root:not(.smrt-content-facts-route__page--embedded))) {
    margin: 0;
    min-height: 100vh;
  }
  .smrt-content-facts-route__root {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
  }
  .smrt-content-facts-route__page--embedded {
    min-height: auto;
    padding: 0;
  }
  .smrt-content-facts-route__container {
    max-width: 1280px;
    margin: 0 auto;
  }
  .smrt-content-facts-route__header {
    margin-bottom: 1.5rem;
  }
  .smrt-content-facts-route__header .smrt-content-facts-route__container {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .smrt-content-facts-route__header-copy {
    max-width: 50rem;
  }
  .smrt-content-facts-route__header-actions {
    display: grid;
    gap: 0.85rem;
    justify-items: end;
  }
  .smrt-content-facts-route__header h1 {
    margin: 0.35rem 0 0.65rem;
  }
  .smrt-content-facts-route__header p {
    margin: 0;
    max-width: 44rem;
  }
  .smrt-content-facts-route__nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
  }
  .smrt-content-facts-route__nav a,
  .smrt-content-facts-route__cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
  }
  .smrt-content-facts-route__main {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-facts-route__filters {
    padding: 1rem;
  }
  .smrt-content-facts-route__panel {
    padding: 1.25rem;
  }
  .smrt-content-facts-route__filters :global(.filters) {
    display: grid;
    grid-template-columns: minmax(0, 1.8fr) repeat(2, auto) auto;
    gap: 0.75rem;
    align-items: end;
  }
  .smrt-content-facts-route__search-field {
    display: grid;
    gap: 0.4rem;
  }
  .smrt-content-facts-route__search-field :global([data-smrt-component="Input"]) {
    min-height: 2.85rem;
    padding: 0 0.95rem;
  }
  .smrt-content-facts-route__toggle {
    min-height: 2.85rem;
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0 0.9rem;
  }
  .smrt-content-facts-route__filters :global(.refresh-button) {
    min-height: 2.85rem;
    padding: 0 1rem;
    cursor: pointer;
  }
  .smrt-content-facts-route__results-panel {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-facts-route__results-meta {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
    padding-bottom: 0.25rem;
  }
  .smrt-content-facts-route__results-meta strong {
    margin-right: 0.5rem;
  }
  .smrt-content-facts-route__results-hints {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .smrt-content-facts-route__results-hints span {
    display: inline-flex;
    align-items: center;
    min-height: 1.9rem;
    padding: 0 0.7rem;
  }
  .smrt-content-facts-route__facts-list {
    display: grid;
  }
  .smrt-content-facts-route__fact-row {
    display: grid;
    gap: 0.9rem;
    padding: 1rem 0;
  }
  .smrt-content-facts-route__fact-row:first-child {
    padding-top: 0;
  }
  .smrt-content-facts-route__fact-row:last-child {
    padding-bottom: 0;
  }
  .smrt-content-facts-route__fact-row-header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .smrt-content-facts-route__fact-row-badges,
  .smrt-content-facts-route__fact-row-stats {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .smrt-content-facts-route__fact-row h2 {
    margin: 0;
  }
  .smrt-content-facts-route__badge {
    display: inline-flex;
    align-items: center;
    min-height: 1.65rem;
    padding: 0 0.6rem;
  }
  details {
    padding-top: 0.8rem;
  }
  details summary {
    cursor: pointer;
  }
  details p {
    margin: 0.75rem 0 0;
    white-space: pre-wrap;
  }
  .smrt-content-facts-route__metadata-list {
    display: flex;
    gap: 0.65rem;
    flex-wrap: wrap;
    margin: 0;
  }
  .smrt-content-facts-route__metadata-list div {
    min-width: 10rem;
    max-width: 18rem;
    display: grid;
    gap: 0.15rem;
  }
  .smrt-content-facts-route__metadata-list dd {
    margin: 0;
    word-break: break-word;
  }
  .smrt-content-facts-route__empty-state h2,
  .smrt-content-facts-route__empty-state p {
    margin: 0;
  }
  @media (max-width: 840px) {
    .smrt-content-facts-route__header-actions {
      width: 100%;
      justify-items: stretch;
    }
    .smrt-content-facts-route__nav {
      justify-content: flex-start;
    }
    .smrt-content-facts-route__filters :global(.filters) {
      grid-template-columns: 1fr;
    }
  }
}

@layer smrt.theme {
  :global(body:has(.smrt-content-facts-route__root:not(.smrt-content-facts-route__page--embedded))) {
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
  }
  .smrt-content-facts-route__eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-content-facts-route__header h1 {
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }
  .smrt-content-facts-route__header p {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-content-facts-route__nav a,
  .smrt-content-facts-route__cta {
    border-radius: var(--smrt-radius-full);
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-facts-route__nav a[aria-current='page'] {
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
  .smrt-content-facts-route__cta {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-color: transparent;
  }
  .smrt-content-facts-route__filters,
  .smrt-content-facts-route__panel {
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 96%,
      transparent
    );
    border-radius: 1rem;
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
  }
  .smrt-content-facts-route__panel--error {
    border-color: color-mix(in srgb, var(--smrt-color-error) 30%, transparent);
  }
  .smrt-content-facts-route__search-field span {
    font-size: var(--smrt-typography-label-large-size, 0.82rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-facts-route__search-field :global([data-smrt-component="Input"]) {
    border-radius: 0.85rem;
    border: var(--smrt-hairline);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-facts-route__toggle {
    border-radius: 0.85rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-facts-route__filters :global(.refresh-button) {
    border-radius: 0.85rem;
    border: none;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-content-facts-route__results-meta {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-content-facts-route__results-meta strong {
    font-size: var(--smrt-typography-title-large-size, 1.2rem);
  }
  .smrt-content-facts-route__results-meta span {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-facts-route__results-hints span {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container-low);
    font-size: var(--smrt-typography-label-large-size, 0.82rem);
  }
  .smrt-content-facts-route__fact-row {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-content-facts-route__fact-row:last-child {
    border-bottom: none;
  }
  .smrt-content-facts-route__fact-row h2 {
    font-size: var(--smrt-typography-title-medium-size, 1.08rem);
    line-height: var(--smrt-typography-title-medium-line-height, 1.45);
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-facts-route__fact-row-stats span {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.84rem);
  }
  .smrt-content-facts-route__badge {
    border-radius: var(--smrt-radius-full);
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
  .smrt-content-facts-route__badge--neutral {
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
  }
  details {
    border-top: var(--smrt-hairline);
  }
  details summary {
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
  }
  details p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-facts-route__metadata-list dt {
    font-size: var(--smrt-typography-label-medium-size, 0.72rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
  }
  .smrt-content-facts-route__metadata-list dd {
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-facts-route__empty-state {
    text-align: center;
  }
  .smrt-content-facts-route__empty-state p {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
