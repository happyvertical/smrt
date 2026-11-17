<script lang="ts">
import { cellText, indexReferences, orderByCreated } from '$lib/ui/columns';
import { recordLabel } from '$lib/ui/fields';
import { modelHref } from '$lib/ui/menu';
import {
  arrangeTabs,
  countLabel,
  FILTER_SCAN_LIMIT,
  filteredHref,
  prefilledNewHref,
  type RelatedData,
  relatedColumns,
  reverseRelations,
} from '$lib/ui/related';
import type { Description, RecordRow } from '$lib/ui/types';

interface Props {
  /** The model of the record being shown. */
  model: string;
  description: Description;
  record: RecordRow;
  /** Loaded rows and counts, one entry per reverse relation. */
  related: RelatedData[];
  /** Records of the models the related tables' link cells point at. */
  references?: Record<string, RecordRow[]>;
}

let { model, description, record, related, references = {} }: Props = $props();

const info = $derived(description.models[model]);
const relations = $derived(reverseRelations(description.models, model));
const data = $derived(new Map(related.map((r) => [r.key, r])));
const lookup = $derived(indexReferences(references));
const count = (key: string) => data.get(key)?.total ?? 0;
const badge = (key: string) =>
  countLabel(count(key), data.get(key)?.truncated ?? false);
const arranged = $derived(
  arrangeTabs(relations.map((r) => ({ key: r.key, count: count(r.key) }))),
);
const byKey = $derived(new Map(relations.map((r) => [r.key, r])));
const thisLabel = $derived(recordLabel(info, record));

let chosen = $state<string | null>(null);
const active = $derived(
  chosen && byKey.has(chosen) ? chosen : (arranged.tabs[0] ?? null),
);

// Narrow screens stack every relation as a collapsible section instead.
let narrow = $state(false);
$effect(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const query = window.matchMedia('(max-width: 40rem)');
  const update = () => {
    narrow = query.matches;
  };
  update();
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
});

let moreOpen = $state(false);
function pick(key: string) {
  chosen = key;
  moreOpen = false;
}
function onTabKeys(event: KeyboardEvent) {
  const keys = arranged.tabs;
  const at = active ? keys.indexOf(active) : -1;
  if (at < 0 || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft'))
    return;
  event.preventDefault();
  const next =
    keys[
      (at + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length
    ];
  chosen = next;
  document.getElementById(`related-tab-${next}`)?.focus();
}
</script>

{#snippet panel(key: string)}
  {@const rel = byKey.get(key)}
  {@const relInfo = rel ? description.models[rel.model] : undefined}
  {#if rel && relInfo}
    {@const loaded = data.get(key)}
    {@const rows = orderByCreated(loaded?.records ?? [])}
    {@const columns = relatedColumns(relInfo, rel.field)}
    {@const lower = relInfo.label.toLowerCase()}
    <div class="smrt-related__panel" data-smrt-part="body">
      {#if rows.length === 0}
        <p class="smrt-app-shell__muted" data-smrt-part="empty">No {lower} for {thisLabel} yet.</p>
      {:else}
        <div class="smrt-app-shell__tablewrap">
          <table class="smrt-app-shell__table" data-smrt-part="table">
            <caption class="smrt-related__sr">{rel.tabLabel} for {thisLabel}</caption>
            <thead>
              <tr>{#each columns as col (col.name)}<th scope="col">{col.label}</th>{/each}</tr>
            </thead>
            <tbody>
              {#each rows as row (row.id)}
                <tr>
                  {#each columns as col, c (col.name)}
                    <td>
                      {#if c === 0}
                        <a class="smrt-app-shell__link" href="{modelHref(rel.model)}/{encodeURIComponent(row.id)}" data-smrt-part="link">
                          {cellText(col.def, row[col.name], description.models, lookup) || recordLabel(relInfo, row)}
                        </a>
                      {:else}
                        {cellText(col.def, row[col.name], description.models, lookup)}
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="smrt-app-shell__muted" data-smrt-part="description">
          Showing {rows.length} of {loaded?.total ?? rows.length}{loaded?.truncated ? '+' : ''}{loaded?.truncated ? ` (only the newest ${FILTER_SCAN_LIMIT} ${lower} were searched)` : ''}
        </p>
      {/if}
      <div class="smrt-related__actions">
        <a class="smrt-app-shell__btn smrt-app-shell__btn-small" href={prefilledNewHref(rel.model, rel.field, record.id)} data-smrt-part="trigger">
          Add {lower}
        </a>
        {#if rows.length > 0}
          <a class="smrt-app-shell__link" href={filteredHref(rel.model, rel.field, record.id)} data-smrt-part="link">
            See all {lower} for {thisLabel}
          </a>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

{#if relations.length > 0}
  <section class="smrt-related__root" aria-label="Related records" data-smrt-part="related">
    {#if narrow}
      {#each [...arranged.tabs, ...arranged.more] as key (key)}
        {@const rel = byKey.get(key)}
        {#if rel}
          <details class="smrt-app-shell__card smrt-related__section" open={arranged.tabs.includes(key) && key === arranged.tabs[0]}>
            <summary>{rel.tabLabel} <span class="smrt-app-shell__badge smrt-related__pill">{badge(key)}</span></summary>
            {@render panel(key)}
          </details>
        {/if}
      {/each}
    {:else}
      <div class="smrt-related__bar">
        <div role="tablist" aria-label="Related records" tabindex="-1" onkeydown={onTabKeys} class="smrt-related__tabs">
          {#each arranged.tabs as key (key)}
            {@const rel = byKey.get(key)}
            {#if rel}
              <button
                type="button"
                role="tab"
                id="related-tab-{key}"
                aria-selected={active === key}
                aria-controls="related-panel"
                tabindex={active === key ? 0 : -1}
                class="smrt-related__tab"
                onclick={() => pick(key)}
              >
                {rel.tabLabel} <span class="smrt-app-shell__badge smrt-related__pill">{badge(key)}</span>
              </button>
            {/if}
          {/each}
        </div>
        {#if arranged.more.length > 0}
          <div class="smrt-related__more">
            <button type="button" class="smrt-related__tab" aria-expanded={moreOpen} aria-haspopup="true" onclick={() => (moreOpen = !moreOpen)}>
              More
            </button>
            {#if moreOpen}
              <ul class="smrt-related__menu" data-smrt-part="menu">
                {#each arranged.more as key (key)}
                  {@const rel = byKey.get(key)}
                  {#if rel}
                    <li>
                      <button type="button" class="smrt-related__menuitem" onclick={() => pick(key)}>
                        {rel.tabLabel} <span class="smrt-app-shell__badge smrt-related__pill">{badge(key)}</span>
                      </button>
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
      {#if active}
        <div role="tabpanel" id="related-panel" aria-labelledby="related-tab-{active}">
          {@render panel(active)}
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-related__root {
    margin-top: 1.5rem;
  }
  .smrt-related__bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .smrt-related__tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .smrt-related__tab {
    cursor: pointer;
    padding: 0.5rem 0.75rem;
  }
  .smrt-related__pill {
    margin-inline-start: 0.25rem;
    padding: 0 0.5rem;
  }
  .smrt-related__more {
    position: relative;
  }
  .smrt-related__menu {
    position: absolute;
    inset-inline-start: 0;
    z-index: 5;
    min-width: 12rem;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
  }
  .smrt-related__menuitem {
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
  }
  .smrt-related__panel {
    padding-top: 0.75rem;
  }
  .smrt-related__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
    margin-top: 0.75rem;
  }
  .smrt-related__section {
    margin-bottom: 0.5rem;
    padding: 0.5rem 0.75rem;
  }
  .smrt-related__section > summary {
    cursor: pointer;
  }
  .smrt-related__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-related__bar {
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }
  .smrt-related__tab {
    appearance: none;
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--smrt-color-on-surface-variant, inherit);
    font: inherit;
  }
  .smrt-related__tab[aria-selected='true'] {
    border-bottom-color: var(--smrt-color-primary);
    color: var(--smrt-color-on-surface, inherit);
    font-weight: 600;
  }
  .smrt-related__menu {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface-container, Canvas);
  }
  .smrt-related__menuitem {
    appearance: none;
    background: none;
    border: 0;
    font: inherit;
    text-align: start;
    color: inherit;
  }
}

</style>
