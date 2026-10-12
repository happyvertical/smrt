<script lang="ts">
import {
  applyCookbookTheme,
  buildCookbookShell,
  CookbookApp,
  CookbookSectionPage,
} from '@happyvertical/smrt-svelte/cookbook';
import {
  ShellSectionIcon,
  WorkspaceAccountMenu,
} from '@happyvertical/smrt-svelte/workspace';
import { type ComponentProps, onMount } from 'svelte';
import smrtMark from '../assets/smrt-mark.svg';
import { catalog, getModel } from '../catalog/index.ts';
import ModelWorkspace from '../components/ModelWorkspace.svelte';
import ThemeBridge from '../components/ThemeBridge.svelte';
import { cookbookStore, SHELL_STORAGE_KEY } from '../cookbook/store.svelte.ts';
import type { Cookbook } from '../cookbook/types.ts';
import { provideDataSource, tryUseDataSource } from '../data/context.ts';
import { createPlannerDataSource } from '../data/planner-source.ts';
import { activeForms } from '../forms/active.ts';
import { recipes } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { DEFAULT_PRESET } from '../theme/theme.ts';
import PlannerControls from './PlannerControls.svelte';
import PlannerLifecycle from './PlannerLifecycle.svelte';
import { plannerShellProps } from './shell.ts';
import type { PlannerProps } from './types.ts';

let {
  controller,
  basePath,
  inference,
  persistence,
  themeControls = true,
  tabs,
  onready,
}: PlannerProps = $props();

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
if (!tryUseDataSource()) provideDataSource(createPlannerDataSource());
let route = $state('');
onMount(() => {
  const read = () => {
    route = location.hash.slice(1);
  };
  read();
  window.addEventListener('hashchange', read);
  window.addEventListener('popstate', read);
  return () => {
    window.removeEventListener('hashchange', read);
    window.removeEventListener('popstate', read);
  };
});

const currentRoute = $derived(route || defaultRoute);
const pathParts = $derived(currentRoute.split('/').filter(Boolean));
const sectionSlug = $derived(pathParts[0] === 's' ? pathParts[1] : undefined);
const model = $derived(
  pathParts[0] === 'm' ? getModel(pathParts[1], pathParts[2]) : undefined,
);
const applied = $derived(model ? recipeState.apply(model) : undefined);
const forms = $derived(
  model ? activeForms(recipeState.ids, recipes, model.id) : [],
);

function updateCookbook(next: ComponentProps<typeof CookbookApp>['cookbook']) {
  cookbookStore.apply(next as Cookbook);
}
</script>

{#snippet customize()}
  <a class="customize" href="#/configure/" aria-label="Customize" title="Customize">
    <ShellSectionIcon name="edit" />
  </a>
{/snippet}

{#snippet userMenu()}
  <WorkspaceAccountMenu userName="User menu" disabled />
{/snippet}

<CookbookApp
  cookbook={cookbook as ComponentProps<typeof CookbookApp>['cookbook']}
  catalog={shellCatalog}
  title={cookbook.name || 'Planner'}
  href={(path) => `#${path}`}
  currentHref={`#${currentRoute}`}
  homeHref={`#${defaultRoute}`}
  storageKey={SHELL_STORAGE_KEY}
  logoSrc={smrtMark}
  slotItems={[
    { id: 'planner-customize', label: 'Customize', slot: 'header.end', render: customize },
    { id: 'user-menu', label: 'User menu', slot: 'leftSidebar.footer', render: userMenu },
  ]}
  oncookbookchange={updateCookbook}
  {...plannerShellProps()}
>
  <ThemeBridge deferInitial={persistence === 'host'} presetOverride={applyCookbookTheme(shell.theme)} />
  <PlannerLifecycle {controller} {basePath} {inference} {persistence} {onready} />
  <main class="content">
    {#if sectionSlug}
      <CookbookSectionPage slug={sectionSlug} />
    {:else if applied && model}
      <ModelWorkspace model={applied.model} fields={applied.fields} {forms} />
    {:else}
      <PlannerControls {controller} {basePath} {inference} {persistence} {themeControls} {tabs} managedByParent layout="shell" />
    {/if}
  </main>
</CookbookApp>

<style>
  .content { width: min(100%, 72rem); margin-inline: auto; padding: var(--smrt-spacing-6); }
  .customize { display: inline-grid; place-items: center; inline-size: 2rem; block-size: 2rem; color: inherit; border-radius: var(--smrt-radius-medium, 0.5rem); }
  .customize:hover { background: var(--smrt-color-surface-container-high); }
  .customize:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
</style>
