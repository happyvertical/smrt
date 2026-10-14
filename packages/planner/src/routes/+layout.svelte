<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import {
  ShellDockTool,
  type ShellNavGroup,
  type ShellNavItem,
} from '@happyvertical/smrt-svelte/workspace';
import { afterNavigate, goto, onNavigate, replaceState } from '$app/navigation';
import { base } from '$app/paths';
import { page } from '$app/state';
import { aiState } from '$lib/ai/instance.ts';
import smrtMark from '$lib/assets/smrt-mark.svg';
import { exposedModels, getModel, getPackage } from '$lib/catalog/index.ts';
import AiStatusIcons from '$lib/components/AiStatusIcons.svelte';
import BrowserAssistant from '$lib/components/BrowserAssistant.svelte';
import HeaderIconLink from '$lib/components/HeaderIconLink.svelte';
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
import { createPlannerDataSource } from '$lib/data/planner-source.ts';
import { loadInferenceConfig } from '$lib/inference/config.ts';
import {
  type KitchenFragment,
  readKitchenFragment,
} from '$lib/kitchen/fragment.ts';
import LiveKitchenBridge from '$lib/kitchen/LiveKitchenBridge.svelte';
import {
  type LiveKitchenBinding,
  liveKitchenBinding,
} from '$lib/kitchen/live.ts';
import { kitchenState } from '$lib/kitchen/state.svelte.ts';
import { libraryState } from '$lib/library/state.svelte.ts';
import { createOnNavigateViewTransition } from '$lib/motion/view-transition.ts';
import { appHref, appQuery, setBasePath } from '$lib/planner/app.svelte.ts';
import { CHEF_HAT_ICON } from '$lib/planner/header-icons.ts';
import { plannerRuntime } from '$lib/planner/instance.ts';
import { hasAppState, withTab } from '$lib/planner/query.ts';
import { recordFilter, recordFilterQuery } from '$lib/planner/routes.ts';
import { selection } from '$lib/planner/selection.svelte.ts';
import {
  plannerAssistantToggle,
  plannerShellProps,
} from '$lib/planner/shell.ts';
import { plannerTab } from '$lib/planner/tab.svelte.ts';
import { currentPlannerTitle } from '$lib/planner/title.svelte.ts';
import { FEATURE_SECTION, featureNavItems } from '$lib/recipes/features.ts';
import {
  buildNavSections,
  navItemId,
  navPath,
  recipeNav,
  recipes,
  sectionId,
} from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import { sectionPath } from '$lib/sections/path.ts';
import type { LayoutProps } from './$types';

let { children }: LayoutProps = $props();

// Sample data follows the cookbook last applied (nothing in the SSR render).
libraryState.load();

// The app's name: the shell brand and the home page title follow it.
const title = $derived(currentPlannerTitle());

// The seam for live objects: swap createPlannerDataSource for a collection-backed DataSource.
const dataSource = provideDataSource(createPlannerDataSource());

// The static app serves from `base`; the planner builds its links from it.
setBasePath(base);

// The controller's commands reach the running app through these.
plannerRuntime.onReplaced = () => dataSource.reset?.();
plannerRuntime.openSection = (id) => {
  void goto(appHref(sectionPath(id)));
};

// No Planner entry: the shell's Edit layout toggle goes to the Planner page.
const nav: ShellNavItem[] = [];
const shellProps = plannerShellProps();

// The sidebar lists these sections with their entries beneath them when
// expanded and icons only in the collapsed rail (`navMode="sections-with-items"`,
// the value `CookbookApp` defaults to; a raw `AppShell` defaults to `items`, so
// the prop stays explicit). Each section opens its own page (`/s/<section>/`).
// Navigation sections belong to the app: a recipe only suggests one
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
let liveBinding = $state<LiveKitchenBinding | null>(null);
let liveLocked = $state(false);
let kitchenFragment: KitchenFragment = { present: false, hash: '' };

const onPlanner = () => page.route.id === '/';

/**
 * A model list page keeps its `?<fk>=<id>` filter (a record's "View all")
 * beside the app query; every other page drops any other parameter.
 */
function withListFilter(query: string): string {
  const { package: packageId, model: modelName } = page.params;
  const model =
    packageId && modelName ? getModel(packageId, modelName) : undefined;
  const filter = model
    ? recordFilterQuery(recordFilter(location.search, model))
    : '';
  if (!filter) return query;
  return query ? `${query}&${filter}` : `?${filter}`;
}

function syncUrl() {
  // A legacy link that could not be saved keeps its URL: it is the only copy.
  if (cookbookStore.keepLegacyUrl) return;
  // The tab belongs to the Planner page only; other pages drop it.
  const wanted = onPlanner()
    ? withTab(appQuery(), plannerTab.active)
    : withListFilter(appQuery());
  if (location.search !== wanted) {
    replaceState(`${location.pathname}${wanted}${location.hash}`, page.state);
  }
}

afterNavigate((navigation) => {
  // Read the saved cookbook once, and fold a legacy ?r= / ?o= link into it.
  // syncUrl below then drops those parameters, as appQuery no longer has them.
  if (!hydrated) {
    hydrated = true;
    liveBinding = import.meta.env.DEV
      ? liveKitchenBinding(location.search)
      : null;
    if (liveBinding) {
      cookbookStore.hostManaged = true;
      cookbookStore.loaded = true;
    } else cookbookStore.hydrate(location.search);
    // The AI state reads its saved choices and decides whether this is a first
    // visit (nothing set up, nothing built, "no AI" not chosen).
    // Where the model runs comes from `planner.config.json` next to the app;
    // the first-visit decision waits for it.
    aiState.awaitConfig();
    aiState.hydrate(
      !!(liveBinding || recipeState.ids.length || recipeState.features.length),
    );
    // `smrt kitchen` opens the page with its one-time token in the fragment
    // (`#kitchen=<token>`), never in planner.config.json. Read it now, keep it
    // in memory, and remove it from the address in `sync` below.
    kitchenFragment = readKitchenFragment(location.hash);
    const kitchenToken = kitchenFragment.token;
    void loadInferenceConfig(base).then((result) => {
      aiState.configure(result);
      kitchenState.configure(result.kitchen, kitchenToken);
    });
  }
  if (hasAppState(location.search)) selection.fromSearch(location.search);
  if (onPlanner()) {
    // Cookbooks is the entry point even when a plan already exists.
    plannerTab.fromSearch(location.search);
  }
  // SvelteKit runs the initial 'enter' callbacks before the router counts as
  // started, and replaceState throws until then, so wait one microtask.
  const sync = async () => {
    // The token is out of the address (and its history entry) before anything
    // else reads or rewrites the URL. `replaceState` alone would leave it in
    // SvelteKit's own copy of the address (`page.url`, and the `pageurl` in
    // the history state), so this is a real navigation, replacing the entry.
    if (kitchenFragment.present) {
      // Once only: the navigation below runs this callback again.
      const clean = `${location.pathname}${location.search}${kitchenFragment.hash}`;
      kitchenFragment = { present: false, hash: kitchenFragment.hash };
      try {
        await goto(clean, {
          replaceState: true,
          noScroll: true,
          keepFocus: true,
        });
      } catch {
        // The router refused: strip it by hand, from SvelteKit's copy too.
        history.replaceState(
          {
            ...history.state,
            'sveltekit:pageurl': new URL(clean, location.href).href,
          },
          '',
          clean,
        );
      }
    }
    ready = true;
    syncUrl();
  };
  if (navigation.type === 'enter') queueMicrotask(sync);
  else sync();
});

// Route changes morph instead of cutting: the shell's `onNavigate` adapter
// pairs SvelteKit's navigation with `document.startViewTransition`, falling
// back to a plain navigation under reduced motion or without the API. The
// shell names its brand, nav and dock for the duration; the planner's own
// names (`planner-*`) crossfade the rest.
onNavigate(createOnNavigateViewTransition());

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
  if (!liveBinding) cookbookStore.scheduleSave();
});

function flushOnHide() {
  if (document.visibilityState === 'hidden' && !liveBinding)
    cookbookStore.flush();
}
</script>

<svelte:window onpagehide={() => !liveBinding && cookbookStore.flush()} />
<svelte:document onvisibilitychange={flushOnHide} />

{#if liveBinding}<LiveKitchenBridge binding={liveBinding} onlock={(locked) => liveLocked = locked} />{/if}

{#snippet aiStatus()}
  <AiStatusIcons />
{/snippet}

{#snippet palette()}
  <PlannerPalette />
{/snippet}

<!-- The chef's hat: the Planner page (Cookbooks, Recipes, Theme, Settings,
     Export), as in the mounted `Planner`; the shell's pencil edits the layout. -->
{#snippet plan()}
  <HeaderIconLink
    href={appHref('/')}
    label="Plan the app"
    path={CHEF_HAT_ICON}
    current={page.route.id === '/'}
    transitionName="planner-customize"
  />
{/snippet}

<div class="shell-host" inert={liveLocked}>
<AppShell
  storageKey={SHELL_STORAGE_KEY}
  {title}
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
    {
      id: 'planner-customize',
      label: 'Plan the app',
      slot: 'header.end',
      render: plan,
    },
  ]}
  dockToggles={[plannerAssistantToggle(appHref('/ai/'), aiState.assistantReady)]}
  borderRadius={cookbookStore.theme?.borderRadius}
  density={cookbookStore.theme?.density}
  contrast={cookbookStore.theme?.contrast}
  {...shellProps}
  layoutEditing={{ slot: 'header.start' }}
  navMode="sections-with-items"
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
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .shell-host { display: contents; }
  /* The shell lays a footer slot out as one row; the planner's `ai-status`
     item shares it with the shell's `item:account`, so stack them (checked
     against 0.55.17: without this the account squashes beside the icons). */
  :global(.smrt-admin-shell__slot--leftSidebar-footer) {
    flex-direction: column;
    align-items: stretch;
    gap: var(--smrt-spacing-2);
  }

  :global(.smrt-admin-shell__slot--leftSidebar-footer > *) {
    inline-size: 100%;
  }

  .storage-notice {
    margin: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-6);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
