<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import {
  ShellDockTool,
  type ShellNavGroup,
  type ShellNavItem,
} from '@happyvertical/smrt-svelte/workspace';
import { afterNavigate, replaceState } from '$app/navigation';
import { page } from '$app/state';
import { blueprintStore } from '$lib/blueprint/store.svelte.ts';
import { exposedModels, getPackage } from '$lib/catalog/index.ts';
import BrowserAssistant from '$lib/components/BrowserAssistant.svelte';
import { provideDataSource } from '$lib/data/context.ts';
import { humanize } from '$lib/data/format.ts';
import { createMemoryDataSource } from '$lib/data/source.ts';
import { PROFILE_TYPE, SAVED_BY_FORMS } from '$lib/forms/stock.ts';
import { appHref, appQuery } from '$lib/planner/app.svelte.ts';
import { hasAppState } from '$lib/planner/query.ts';
import { selection } from '$lib/planner/selection.svelte.ts';
import { recipeNav, recipes, sectionId } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { Recipe } from '$lib/recipes/types.ts';
import type { LayoutProps } from './$types';

let { children }: LayoutProps = $props();

// The seam for live objects: swap this for a collection-backed DataSource.
provideDataSource(
  createMemoryDataSource({
    // Fields the views hide still carry their policy default, e.g. the
    // `contractType` that tells an Order from a PurchaseOrder.
    defaults: (model) => recipeState.apply(model).background,
    // Rows that only make sense under a product a form creates start empty,
    // as do Profile types: a form adds the one it needs.
    empty: [...SAVED_BY_FORMS, PROFILE_TYPE],
  }),
);

const nav: ShellNavItem[] = $derived([
  { id: 'planner', href: appHref('/'), label: 'Planner' },
  { id: 'blueprint', href: appHref('/blueprint/'), label: 'Blueprint' },
]);

// Each added recipe (or group of recipes, such as Products) is a navigation
// section with its `nav` entries, so the app shows Customers and Sales
// Orders, not every model in smrt-commerce. Recipes of one group share their
// entries, so Simple and Clothing give one Products link. Options and Help
// are icons in each page's header, not entries here.
const recipeGroups: ShellNavGroup[] = $derived.by(() => {
  const sections = new Map<
    string,
    { key: string; heading: string; added: Recipe[] }
  >();
  for (const id of recipeState.ids) {
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe) continue;
    const key = sectionId(recipe);
    const section = sections.get(key) ?? {
      key,
      heading: recipe.group?.label ?? recipe.label,
      added: [],
    };
    section.added.push(recipe);
    sections.set(key, section);
  }
  return [...sections.values()].map(({ key, heading, added }) => {
    const seen = new Set<string>();
    const entries = added.flatMap((recipe) =>
      recipeNav(recipe).filter((entry) => {
        const key = `${entry.model.id}:${entry.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
    // Stable ids keep a saved layout valid when the selection query in the
    // hrefs changes. The section's options gear sits on its main (first) item
    // and shows only while that section is current.
    return {
      id: `section:${key}`,
      heading,
      items: entries.map((entry, index) => ({
        id: `section:${key}:${entry.packageId}:${entry.model.name}:${entry.label}`,
        href: appHref(`/m/${entry.packageId}/${entry.model.name}/`),
        label: entry.label,
        ...(index === 0
          ? {
              action: {
                href: appHref(`/recipes/${key}/`),
                label: `${heading} options`,
                visibility: 'active' as const,
              },
            }
          : {}),
      })),
    };
  });
});

const packageGroups: ShellNavGroup[] = $derived(
  selection.ids.flatMap((id) => {
    const pkg = getPackage(id);
    if (!pkg) return [];
    return [
      {
        id: `package:${pkg.id}`,
        heading: humanize(pkg.id),
        items: [
          {
            id: `package:${pkg.id}:overview`,
            href: appHref(`/packages/${pkg.id}/`),
            label: 'Overview',
          },
          ...exposedModels(pkg).map((model) => ({
            id: `package:${pkg.id}:${model.name}`,
            href: appHref(`/m/${pkg.id}/${model.name}/`),
            label: model.name,
          })),
        ],
      },
    ];
  }),
);

const navGroups: ShellNavGroup[] = $derived([
  ...recipeGroups,
  ...packageGroups,
]);

// The URL carries the package selection so a mock-up can be shared; recipes,
// options and layout are the blueprint, saved in localStorage. Pages are
// prerendered, so both are only read in the browser, after navigation.
let ready = false;
let hydrated = false;

function syncUrl() {
  // A legacy link that could not be saved keeps its URL: it is the only copy.
  if (blueprintStore.keepLegacyUrl) return;
  const wanted = appQuery();
  if (location.search !== wanted) {
    replaceState(`${location.pathname}${wanted}${location.hash}`, page.state);
  }
}

afterNavigate((navigation) => {
  // Read the saved blueprint once, and fold a legacy ?r= / ?o= link into it.
  // syncUrl below then drops those parameters, as appQuery no longer has them.
  if (!hydrated) {
    hydrated = true;
    blueprintStore.hydrate(location.search);
  }
  if (hasAppState(location.search)) selection.fromSearch(location.search);
  // SvelteKit runs the initial 'enter' callbacks before the router counts as
  // started, and replaceState throws until then, so wait one microtask.
  const sync = () => {
    ready = true;
    syncUrl();
  };
  if (navigation.type === 'enter') queueMicrotask(sync);
  else sync();
});

// Keep the address bar in step with the selection as it changes.
$effect(() => {
  // appQuery reads every part of the shareable state, so this tracks them all.
  void appQuery();
  void blueprintStore.keepLegacyUrl;
  if (ready) syncUrl();
});

// Save the blueprint soon after any change; the store ignores this until the
// saved one has been read, so loading never overwrites it with an empty one.
$effect(() => {
  // Reading it all (layout is deep) subscribes the effect to every part.
  void JSON.stringify(blueprintStore.snapshot());
  blueprintStore.scheduleSave();
});

function flushOnHide() {
  if (document.visibilityState === 'hidden') blueprintStore.flush();
}
</script>

<svelte:window onpagehide={() => blueprintStore.flush()} />
<svelte:document onvisibilitychange={flushOnHide} />

<AppShell
  title="smrt planner"
  subtitle="Add recipes, watch the app assemble"
  {nav}
  {navGroups}
  currentHref={page.url.pathname + appQuery()}
  environment="static demo"
  layout={blueprintStore.layout ?? null}
  onlayoutchange={(next) => blueprintStore.setLayout(next)}
  dockToggles={[{ tool: 'assistant', label: 'Assistant' }]}
>
  {#snippet dock(registry)}
    <ShellDockTool id="assistant" label="Assistant">
      {#snippet render()}
        <BrowserAssistant {registry} />
      {/snippet}
    </ShellDockTool>
  {/snippet}
  {#if blueprintStore.persist === 'memory'}
    <p class="storage-notice" role="status">
      This browser is not saving your blueprint, so it is kept in memory only. Export it from Blueprint to keep a copy.
    </p>
  {/if}
  {#if blueprintStore.loadNotice}
    <p class="storage-notice" role="status">{blueprintStore.loadNotice}</p>
  {/if}
  {@render children()}
</AppShell>

<style>
  .storage-notice {
    margin: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-6);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
  }
</style>
