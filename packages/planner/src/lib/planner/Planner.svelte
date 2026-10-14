<script lang="ts">
import type { ShellSlotItem } from '@happyvertical/smrt-svelte/app';
import {
  applyCookbookTheme,
  buildCookbookShell,
  CookbookApp,
  type CookbookSectionHeadingInfo,
  CookbookSectionPage,
} from '@happyvertical/smrt-svelte/cookbook';
import {
  ShellDockTool,
  ShellSectionIcon,
} from '@happyvertical/smrt-svelte/workspace';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { type ComponentProps, onMount, tick, untrack } from 'svelte';
import { aiState } from '../ai/instance.ts';
import smrtMark from '../assets/smrt-mark.svg';
import { catalog, getModel } from '../catalog/index.ts';
import AdvancedStyles from '../components/AdvancedStyles.svelte';
import AiModelsPage from '../components/AiModelsPage.svelte';
import BrowserAssistant from '../components/BrowserAssistant.svelte';
import ModelWorkspace from '../components/ModelWorkspace.svelte';
import PackagePage from '../components/PackagePage.svelte';
import RecordView from '../components/RecordView.svelte';
import SectionHeading from '../components/SectionHeading.svelte';
import ThemeBridge from '../components/ThemeBridge.svelte';
import { cookbookStore, SHELL_STORAGE_KEY } from '../cookbook/store.svelte.ts';
import type { Cookbook } from '../cookbook/types.ts';
import { provideDataSource, tryUseDataSource } from '../data/context.ts';
import { createPlannerDataSource } from '../data/planner-source.ts';
import { activeForms } from '../forms/active.ts';
import { runViewTransition } from '../motion/view-transition.ts';
import { plannerLoaders, resolveRecipeExport } from '../overviews/registry.ts';
import {
  hasNavKey,
  recipeNav,
  recipes,
  recipesById,
} from '../recipes/index.ts';
import { pageScope, scopePreset } from '../recipes/scope.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { entryIndex } from '../sections/entries.ts';
import { sectionInfo, sectionTitle } from '../sections/info.ts';
import { sectionIdFromSlug } from '../sections/path.ts';
import { DEFAULT_PRESET } from '../theme/theme.ts';
import { appHref, setBasePath } from './app.svelte.ts';
import PlannerControls from './PlannerControls.svelte';
import PlannerLifecycle from './PlannerLifecycle.svelte';
import { parseModelRoute, recordFilter, splitRoute } from './routes.ts';
import { plannerAssistantToggle, plannerShellProps } from './shell.ts';
import { currentPlannerTitle } from './title.svelte.ts';
import type { PlannerProps } from './types.ts';

let {
  controller,
  basePath,
  inference,
  persistence,
  themeControls = true,
  tabs,
  backLink,
  onready,
}: PlannerProps = $props();

/** The mount's links: its pages are fragment routes, so no host router. */
const hashHref = (path: string) => `#${path}`;
// Before anything below renders a link: the planner-wide `appHref` writes
// fragments too (`PlannerLifecycle` follows `basePath` when it changes).
setBasePath(untrack(() => basePath) ?? '', 'hash');
/** The assistant exists only when the host gave the planner a model. */
const assistant = $derived(inference !== undefined);

const shellCatalog: ComponentProps<typeof CookbookApp>['catalog'] = {
  recipes: recipes.map(({ id, label, nav, models, group, section }) => ({
    id,
    label,
    nav,
    models,
    group,
    section,
  })),
  models: catalog.packages.flatMap((pkg) =>
    pkg.models.map((model) => ({
      id: model.id,
      name: model.name,
      packageId: pkg.id,
      description: model.description,
      exposed: model.exposed,
    })),
  ),
};
// The shell falls back to its own default preset; give it the Planner's so the
// shell provider and ThemeBridge agree when a cookbook names no theme.
const cookbook = $derived.by(() => {
  const value = cookbookStore.snapshot();
  return value.theme?.preset || value.theme?.custom
    ? value
    : { ...value, theme: { ...value.theme, preset: DEFAULT_PRESET } };
});
const title = $derived(currentPlannerTitle());
const shell = $derived(
  buildCookbookShell({
    cookbook: cookbook as ComponentProps<typeof CookbookApp>['cookbook'],
    catalog: shellCatalog,
  }),
);
const defaultRoute = $derived.by(() => {
  const orderedId = cookbook.layout?.sectionOrder?.find(
    (id) =>
      !cookbook.layout?.hidden?.includes(id) &&
      Object.hasOwn(shell.overviews, id),
  );
  const firstId = orderedId ?? shell.sections[0]?.id;
  return firstId ? shell.sectionPath(firstId) : '/configure/';
});
const source =
  tryUseDataSource() ?? provideDataSource(createPlannerDataSource());
// The app's menu entries with the model and scope each lists, for the
// shortcuts' record counts.
const sectionEntries = $derived(
  entryIndex(
    recipeState.ids.flatMap((id) => {
      const recipe = recipesById.get(id);
      return recipe ? [recipe] : [];
    }),
    recipeState.features,
  ),
);
// What the overview widgets' loaders read when they run in this browser: the
// sample source, the mount's links and the entry index. The shell adds the
// resolved sections and its own entries for its shortcuts.
const widgetContext = () => ({
  source,
  href: hashHref,
  entryIndex: sectionEntries,
});
// A reset (a cookbook applied, the app reset) swaps the rows underneath the
// section page; remounting it reloads its widgets.
let dataGeneration = $state(0);
$effect(() =>
  source.onReset?.(() => {
    dataGeneration += 1;
  }),
);
let route = $state('');
// The mount's own hash router. Each change morphs through a view transition
// (the chrome named below stays put, the content crossfades); the first read
// paints plainly. `tick` keeps the DOM update inside the transition's
// callback, where the browser snapshots the new state.
onMount(() => {
  // One hash change fires both `hashchange` and `popstate`, and `route` is
  // only assigned inside the transition callback (after the old frame is
  // captured), so the target is tracked synchronously to transition once.
  let target = location.hash.slice(1);
  route = target;
  const read = () => {
    const next = location.hash.slice(1);
    if (next === target) return;
    target = next;
    void runViewTransition(async () => {
      route = next;
      await tick();
    });
  };
  window.addEventListener('hashchange', read);
  window.addEventListener('popstate', read);
  return () => {
    window.removeEventListener('hashchange', read);
    window.removeEventListener('popstate', read);
  };
});

const currentRoute = $derived(route || defaultRoute);
// A fragment route may carry a query (`#/m/commerce/Order/?customerId=x`).
const routeParts = $derived(splitRoute(currentRoute));
const pathParts = $derived(routeParts.path.split('/').filter(Boolean));
const sectionSlug = $derived(pathParts[0] === 's' ? pathParts[1] : undefined);
const packageId = $derived(
  pathParts[0] === 'packages' ? pathParts[1] : undefined,
);
// `/m/<pkg>/<Model>/`, a keyed entry, a record's view or edit page.
const modelRoute = $derived(
  pathParts[0] === 'm'
    ? parseModelRoute(pathParts.slice(1), hasNavKey)
    : undefined,
);
const model = $derived(
  modelRoute ? getModel(modelRoute.packageId, modelRoute.modelName) : undefined,
);
const applied = $derived(model ? recipeState.apply(model) : undefined);
const forms = $derived(
  model ? activeForms(recipeState.ids, recipes, model.id) : [],
);
// The slice a list page shows: a record's "View all" query, else the keyed
// entry's filter (the plain entry gives those rows up).
const scope = $derived.by(() => {
  if (!model || !modelRoute) return undefined;
  return (
    recordFilter(routeParts.search, model) ??
    pageScope(
      model.id,
      modelRoute.view,
      recipeState.ids.flatMap((id) => {
        const recipe = recipes.find((r) => r.id === id);
        return recipe ? recipeNav(recipe) : [];
      }),
    )
  );
});
const preset = $derived(scopePreset(scope));
/** The mount's own way around: a fragment route. */
const navigate = (path: string) => {
  location.hash = path;
};

function updateCookbook(next: ComponentProps<typeof CookbookApp>['cookbook']) {
  cookbookStore.apply(next as Cookbook);
}

const slotItems = $derived<ShellSlotItem[]>([
  ...(backLink
    ? [
        {
          id: 'planner-back',
          label: backLink.label,
          slot: 'header.start' as const,
          render: back,
        },
      ]
    : []),
  {
    id: 'planner-customize',
    label: 'Customize',
    slot: 'header.end' as const,
    render: customize,
  },
]);
// The shell's own `dock:assistant` button (header end, the dock tab on phones)
// opens the assistant dock; until the assistant can answer it is a link to the
// mount's AI setup page.
const dockToggles = $derived(
  assistant
    ? [plannerAssistantToggle(appHref('/ai/'), aiState.assistantReady)]
    : [],
);
</script>

{#snippet back()}
  <a class="back" href={backLink?.href} data-planner-back>
    <span aria-hidden="true">←</span>
    <span>{backLink?.label}</span>
  </a>
{/snippet}

{#snippet assistantDock(registry: DataSurfaceRegistry)}
  <ShellDockTool id="assistant" label="Assistant">
    {#snippet render()}
      <BrowserAssistant {registry} settingsHref={appHref('/ai/')} />
    {/snippet}
  </ShellDockTool>
{/snippet}

{#snippet sectionHeading({ section }: { section: CookbookSectionHeadingInfo })}
  <SectionHeading
    icon={section.icon}
    title={sectionTitle(section.title)}
    description={sectionInfo(section.id).description ?? section.description}
  />
{/snippet}

{#snippet customize()}
  <a class="customize" href="#/configure/" aria-label="Customize" title="Customize">
    <ShellSectionIcon name="edit" />
  </a>
{/snippet}

<!--
  The shell's pencil (`layoutEditing`, start of the header) edits the menu
  and every section overview in place; each edit comes back through
  `oncookbookchange` and lands in the cookbook's `layout` / `overviews`, so it
  is saved, exported and imported with the rest of the plan. `loaders`,
  `widgetContext` and `resolveExport` wire the framework's own section pages
  (`CookbookSectionPage`, drawn `plain` with the planner's heading) to the
  sample data; `loaders.shortcuts` adds the record counts.
-->
<CookbookApp
  cookbook={cookbook as ComponentProps<typeof CookbookApp>['cookbook']}
  catalog={shellCatalog}
  {title}
  href={hashHref}
  currentHref={`#${currentRoute}`}
  homeHref={`#${defaultRoute}`}
  storageKey={SHELL_STORAGE_KEY}
  logoSrc={smrtMark}
  {slotItems}
  {dockToggles}
  dock={assistant ? assistantDock : undefined}
  loaders={plannerLoaders}
  {widgetContext}
  resolveExport={resolveRecipeExport}
  layoutEditing={{ slot: 'header.start' }}
  oncookbookchange={updateCookbook}
  {...plannerShellProps()}
>
  <ThemeBridge deferInitial={persistence === 'host'} presetOverride={applyCookbookTheme(shell.theme)} />
  <PlannerLifecycle {controller} {basePath} {inference} {persistence} {onready} links="hash" />
  <main class="content">
    {#if sectionSlug}
      {#if cookbookStore.loaded}
        {#key `${sectionSlug}:${dataGeneration}`}
          <CookbookSectionPage
            sectionId={sectionIdFromSlug(sectionSlug)}
            presentation="plain"
            heading={sectionHeading}
          />
        {/key}
      {/if}
    {:else if packageId}
      <PackagePage id={packageId} backHref="#/configure/" />
    {:else if pathParts[0] === 'advanced-styles'}
      <AdvancedStyles backHref="#/configure/" />
    {:else if pathParts[0] === 'ai'}
      <AiModelsPage backHref="#/configure/" />
    {:else if applied && model && modelRoute?.recordId}
      {#key `${model.id}:${modelRoute.recordId}`}
        <RecordView
          packageId={modelRoute.packageId}
          modelName={modelRoute.modelName}
          recordId={modelRoute.recordId}
          mode={modelRoute.mode}
          href={hashHref}
          {navigate}
        />
      {/key}
    {:else if applied && model}
      <ModelWorkspace model={applied.model} fields={applied.fields} {forms} {scope} {preset} href={hashHref} />
    {:else}
      <PlannerControls {controller} {basePath} {inference} {persistence} {themeControls} {tabs} managedByParent layout="shell" advancedStylesHref="#/advanced-styles/" />
    {/if}
  </main>
</CookbookApp>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  /* `view-transition-name`s: one per surface per screen (a duplicate aborts
     the transition). AppShell names its brand, nav and dock (`smrt-shell-*`,
     reserved); these are the planner's own. Like the shell's, they apply only
     while a transition runs (`html[data-smrt-view-transition]`, set by
     `runViewTransition`): a name makes a stacking context, and a permanent
     one on `.content` trapped the record page's phone edit sheet under the
     shell's top bar. */
  .content { width: min(100%, 72rem); margin-inline: auto; padding: var(--smrt-spacing-6); }
  :global([data-smrt-view-transition]) .content { view-transition-name: planner-content; }
  :global([data-smrt-view-transition]) .customize { view-transition-name: planner-customize; }
  :global([data-smrt-view-transition]) .back { view-transition-name: planner-back; }
  .customize { display: inline-grid; place-items: center; inline-size: 2rem; block-size: 2rem; color: inherit; border-radius: var(--smrt-radius-medium, 0.5rem); }
  .customize:hover { background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent); }
  .customize:focus-visible { outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color); outline-offset: var(--smrt-focus-ring-offset); }
  .back { display: inline-flex; align-items: center; gap: var(--smrt-spacing-1); block-size: 2rem; padding-inline: var(--smrt-spacing-2); color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-small-size, 0.8125rem); text-decoration: none; white-space: nowrap; border-radius: var(--smrt-radius-medium, 0.5rem); }
  .back:hover { background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent); color: var(--smrt-color-on-surface); }
  .back:focus-visible { outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color); outline-offset: var(--smrt-focus-ring-offset); }
}
</style>
