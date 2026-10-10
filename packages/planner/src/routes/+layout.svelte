<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import {
  ShellDockTool,
  type ShellNavGroup,
  type ShellNavItem,
} from '@happyvertical/smrt-svelte/workspace';
import { afterNavigate, replaceState } from '$app/navigation';
import { page } from '$app/state';
import { aiState } from '$lib/ai/instance.ts';
import smrtMark from '$lib/assets/smrt-mark.svg';
import { catalog, exposedModels, getPackage } from '$lib/catalog/index.ts';
import AiStatusIcons from '$lib/components/AiStatusIcons.svelte';
import BrowserAssistant from '$lib/components/BrowserAssistant.svelte';
import PlannerEditBridge from '$lib/components/PlannerEditBridge.svelte';
import PlannerPalette from '$lib/components/PlannerPalette.svelte';
import SectionActions from '$lib/components/SectionActions.svelte';
import ThemeBridge from '$lib/components/ThemeBridge.svelte';
import { browserStorage } from '$lib/cookbook/storage.ts';
import {
  cookbookStore,
  SHELL_STORAGE_KEY,
} from '$lib/cookbook/store.svelte.ts';
import { provideDataSource } from '$lib/data/context.ts';
import { humanize } from '$lib/data/format.ts';
import { createMemoryDataSource } from '$lib/data/source.ts';
import { catalogModels } from '$lib/forms/shared.ts';
import { PROFILE_TYPE, stockSamples, VARIANT } from '$lib/forms/stock.ts';
import { libraryState } from '$lib/library/state.svelte.ts';
import { appHref, appQuery } from '$lib/planner/app.svelte.ts';
import { hasAppState, withTab } from '$lib/planner/query.ts';
import { selection } from '$lib/planner/selection.svelte.ts';
import { plannerTab } from '$lib/planner/tab.svelte.ts';
import { FEATURE_SECTION, featureNavItems } from '$lib/recipes/features.ts';
import {
  buildNavSections,
  navItemId,
  navPath,
  recipeNav,
  recipes,
  sectionId,
} from '$lib/recipes/index.ts';
import { childLinks } from '$lib/recipes/plumbing.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import { sectionPath } from '$lib/sections/path.ts';
import type { LayoutProps } from './$types';

let { children }: LayoutProps = $props();

// Sample data follows the cookbook last applied (nothing in the SSR render).
libraryState.load();

// The seam for live objects: swap this for a collection-backed DataSource.
provideDataSource(
  createMemoryDataSource({
    // Added, edited and deleted rows survive a reload; Reset clears them.
    storage: browserStorage(),
    // Fields the views hide still carry their policy default, e.g. the
    // `contractType` that tells an Order from a PurchaseOrder.
    defaults: (model) => recipeState.apply(model).background,
    // Variants only make sense under a product a form creates, so they start
    // empty, as do Profile types: a form adds the one it needs. Locations, SKUs
    // and stock are sampled together (one SKU per product).
    empty: [VARIANT, PROFILE_TYPE],
    samples: stockSamples(catalogModels),
    // Every sample parent comes with line items: the same parent-to-children
    // lookup the record view uses, so what it shows is what was seeded.
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  }),
);

// No Planner entry: the shell's Edit layout toggle goes to the Planner page.
const nav: ShellNavItem[] = [];

// The sidebar lists only these sections (`navMode="sections"`); each opens its
// own page (`/s/<section>/`) listing the entries. Navigation sections belong to the app: a recipe only suggests one
// (`recipe.section`, else its group, else itself), and the user overrides it in
// the Layout tab. Recipes suggesting the same section share it, entries
// de-duplicated in recipe declaration order. Each recipe's main (first) item
// carries the gear to ITS options page (keyed by `group`, not by section), shown
// while that item is current. Help is an icon in page headers, not an entry.
const recipeGroups: ShellNavGroup[] = $derived.by(() => {
  const added = recipeState.ids.flatMap((id) => {
    const recipe = recipes.find((r) => r.id === id);
    return recipe ? [recipe] : [];
  });
  // A section none of whose recipes has a menu entry (an assistant, a settings
  // panel) is left out rather than shown empty.
  return buildNavSections(added).flatMap((section) => {
    const seen = new Set<string>();
    const items: ShellNavItem[] = [];
    for (const recipe of section.recipes) {
      const optionsHref = appHref(`/recipes/${sectionId(recipe)}/`);
      const optionsLabel = `${recipe.group?.label ?? recipe.label} options`;
      let main = true;
      for (const entry of recipeNav(recipe)) {
        const id = navItemId(entry.packageId, entry.model.name, entry.key);
        if (seen.has(id)) continue;
        seen.add(id);
        // Stable ids keep a saved layout valid when the selection query in the
        // hrefs changes.
        items.push({
          id,
          href: appHref(navPath(entry)),
          label: entry.label,
          icon: entry.icon,
          description: entry.description,
          ...(main
            ? {
                action: {
                  href: optionsHref,
                  label: optionsLabel,
                  visibility: 'active' as const,
                },
              }
            : {}),
        });
        main = false;
      }
    }
    if (items.length === 0) return [];
    const id = `section:${section.id}`;
    return [
      {
        id,
        heading: section.label,
        icon: section.icon,
        href: appHref(sectionPath(id)),
        items,
      },
    ];
  });
});

// Options/Help groups per navigation section, for the layout edit mode's
// section actions (a nav section can hold several recipes' items).
const sectionOptionGroups = $derived.by(() => {
  const added = recipeState.ids.flatMap((id) => {
    const recipe = recipes.find((r) => r.id === id);
    return recipe ? [recipe] : [];
  });
  const map = new Map<string, { id: string; label: string }[]>();
  for (const section of buildNavSections(added)) {
    const groups: { id: string; label: string }[] = [];
    for (const recipe of section.recipes) {
      const id = sectionId(recipe);
      if (!groups.some((g) => g.id === id)) {
        groups.push({ id, label: recipe.group?.label ?? recipe.label });
      }
    }
    map.set(`section:${section.id}`, groups);
  }
  return map;
});

// Added feature models share one suggested section after the recipes'; the
// layout overrides it like any other. They have no per-recipe options page.
const featureGroups: ShellNavGroup[] = $derived.by(() => {
  const items = featureNavItems(recipeState.features).map((item) => ({
    id: item.id,
    href: appHref(`/m/${item.packageId}/${item.modelName}/`),
    label: item.label,
    icon: item.icon,
    description: item.description,
  }));
  return items.length
    ? [
        {
          id: `section:${FEATURE_SECTION.id}`,
          heading: FEATURE_SECTION.label,
          icon: FEATURE_SECTION.icon,
          href: appHref(sectionPath(`section:${FEATURE_SECTION.id}`)),
          items,
        },
      ]
    : [];
});

const packageGroups: ShellNavGroup[] = $derived(
  selection.ids.flatMap((id) => {
    const pkg = getPackage(id);
    if (!pkg) return [];
    return [
      {
        id: `package:${pkg.id}`,
        heading: humanize(pkg.id),
        icon: 'layers',
        href: appHref(`/packages/${pkg.id}/`),
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
  ...featureGroups,
  ...packageGroups,
]);

// The URL carries the package selection so a mock-up can be shared; recipes,
// options and layout are the cookbook, saved in localStorage. Pages are
// prerendered, so both are only read in the browser, after navigation.
let ready = false;
let hydrated = false;

const onPlanner = () => page.route.id === '/';

function syncUrl() {
  // A legacy link that could not be saved keeps its URL: it is the only copy.
  if (cookbookStore.keepLegacyUrl) return;
  // The tab belongs to the Planner page only; other pages drop it.
  const wanted = onPlanner()
    ? withTab(appQuery(), plannerTab.active)
    : appQuery();
  if (location.search !== wanted) {
    replaceState(`${location.pathname}${wanted}${location.hash}`, page.state);
  }
}

afterNavigate((navigation) => {
  // Read the saved cookbook once, and fold a legacy ?r= / ?o= link into it.
  // syncUrl below then drops those parameters, as appQuery no longer has them.
  if (!hydrated) {
    hydrated = true;
    cookbookStore.hydrate(location.search);
    // The AI state reads its saved choices and decides whether this is a first
    // visit (nothing set up, nothing built, "no AI" not chosen).
    aiState.hydrate(!!(recipeState.ids.length || recipeState.features.length));
  }
  if (hasAppState(location.search)) selection.fromSearch(location.search);
  if (onPlanner()) {
    // A visitor with nothing built yet lands on the Cookbooks tab.
    plannerTab.fromSearch(
      location.search,
      recipeState.ids.length || recipeState.features.length
        ? 'recipes'
        : 'cookbooks',
    );
  }
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
  void cookbookStore.keepLegacyUrl;
  void plannerTab.active;
  void page.route.id;
  if (ready) syncUrl();
});

// Save the cookbook soon after any change; the store ignores this until the
// saved one has been read, so loading never overwrites it with an empty one.
$effect(() => {
  // Reading it all (layout is deep) subscribes the effect to every part.
  void JSON.stringify(cookbookStore.snapshot());
  cookbookStore.scheduleSave();
});

function flushOnHide() {
  if (document.visibilityState === 'hidden') cookbookStore.flush();
}
</script>

<svelte:window onpagehide={() => cookbookStore.flush()} />
<svelte:document onvisibilitychange={flushOnHide} />

{#snippet aiStatus()}
  <AiStatusIcons />
{/snippet}

{#snippet palette()}
  <PlannerPalette />
{/snippet}

<AppShell
  storageKey={SHELL_STORAGE_KEY}
  title="Planner"
  logoSrc={smrtMark}
  homeHref={appHref('/')}
  {nav}
  {navGroups}
  currentHref={page.url.pathname + appQuery()}
  environment="static demo"
  layout={cookbookStore.layout ?? null}
  onlayoutchange={(next) => cookbookStore.setLayout(next)}
  slotItems={[
    {
      id: 'ai-status',
      label: 'AI status',
      slot: 'leftSidebar.footer',
      render: aiStatus,
    },
    {
      id: 'palette',
      label: 'Search',
      slot: 'header.center',
      render: palette,
    },
  ]}
  dockToggles={[{ tool: 'assistant', label: 'Assistant', slot: 'header.end' }]}
  config={{ right: { initial: 'collapsed', rail: false, presentation: 'overlay' } }}
  layoutEditing={{ slot: 'header.start' }}
  navMode="sections"
  sectionHref={(id) => appHref(sectionPath(id))}
>
  {#snippet sectionActions({ sectionId: navSectionId, label })}
    <SectionActions {label} groups={sectionOptionGroups.get(navSectionId) ?? []} />
  {/snippet}
  {#snippet dock(registry)}
    <ShellDockTool id="assistant" label="Assistant">
      {#snippet render()}
        <BrowserAssistant {registry} />
      {/snippet}
    </ShellDockTool>
  {/snippet}
  {#if cookbookStore.persist === 'memory'}
    <p class="storage-notice" role="status">
      This browser is not saving your cookbook, so it is kept in memory only. Export it from the Planner's Export tab to keep a copy.
    </p>
  {/if}
  {#if cookbookStore.loadNotice}
    <p class="storage-notice" role="status">{cookbookStore.loadNotice}</p>
  {/if}
  {#if cookbookStore.unavailableNotice}
    <p class="storage-notice" role="status">
      {cookbookStore.unavailableNotice}
      <button type="button" onclick={() => cookbookStore.removeUnavailable()}>
        Remove them
      </button>
    </p>
  {/if}
  <PlannerEditBridge />
  <ThemeBridge />
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
