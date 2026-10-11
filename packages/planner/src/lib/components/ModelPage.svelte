<script lang="ts">
import { useShellLayout } from '@happyvertical/smrt-svelte/workspace';
import { page } from '$app/state';
import { catalog, getModel } from '../catalog/index.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { humanize, navNoun } from '../data/format.ts';
import { activeForms } from '../forms/active.ts';
import { PRODUCT } from '../forms/stock.ts';
import { appHref } from '../planner/app.svelte.ts';
import { selection } from '../planner/selection.svelte.ts';
import { FEATURE_SECTION } from '../recipes/features.ts';
import { renderHelp } from '../recipes/help.ts';
import {
  helpModels,
  navPath,
  recipeNav,
  recipes,
  sectionId,
} from '../recipes/index.ts';
import {
  childLinks,
  childTitle,
  hasNavPage,
  lineageNames,
} from '../recipes/plumbing.ts';
import { pageScope, scopePreset } from '../recipes/scope.ts';
import { navSectionOf } from '../recipes/sections.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { sectionPath } from '../sections/path.ts';
import FormWorkspace from './FormWorkspace.svelte';
import ModelWorkspace from './ModelWorkspace.svelte';
import SectionIcons from './SectionIcons.svelte';

interface ModelPageProps {
  packageId: string;
  modelName: string;
  /** The key of the nav entry this page is (`/m/<pkg>/<Model>/<key>/`). */
  view?: string;
}

let { packageId, modelName, view }: ModelPageProps = $props();

const catalogModel = $derived(getModel(packageId, modelName));
// Recipe options (field policies, narrowed exposure) shape what is shown.
const applied = $derived(
  catalogModel ? recipeState.apply(catalogModel) : undefined,
);
const model = $derived(applied?.model);
// Added recipes' forms (with their extensions) replace the generic form.
const forms = $derived(
  catalogModel ? activeForms(recipeState.ids, recipes, catalogModel.id) : [],
);
const recipesWithModel = $derived(
  recipes.filter(
    (recipe) => catalogModel && recipe.models.includes(catalogModel.id),
  ),
);
// The recipe the header icons belong to: an added one first. Its section's
// Help and Options pages are what the icons open.
const iconRecipe = $derived(
  recipesWithModel.find((recipe) => recipeState.has(recipe.id)) ??
    recipesWithModel[0],
);
const iconSection = $derived(iconRecipe ? sectionId(iconRecipe) : undefined);
const iconLabel = $derived(
  iconRecipe ? (iconRecipe.group?.label ?? iconRecipe.label) : '',
);
// Breadcrumbs follow the app's own navigation, not catalog packages: the menu
// section the model sits in (the user's renamed label wins) and its menu label.
const shellLayout = useShellLayout();
// The menu as the visitor sees it (renamed sections and entries, from a
// cookbook or edit mode): the entry linking to this page wins.
interface Crumb {
  section: string;
  label: string;
  /** The layout id of the section, to link its page. */
  sectionId?: string;
}
const shellCrumb = $derived.by((): Crumb | undefined => {
  const here = page.url.pathname;
  const path = (href: string) => new URL(href, page.url).pathname;
  for (const group of shellLayout.applied.groups) {
    const item = group.items.find((i) => path(i.href) === here);
    if (item) {
      return {
        section: group.heading,
        label: item.label,
        sectionId: group.id ?? group.heading,
      };
    }
  }
  const item = shellLayout.applied.nav.find((i) => path(i.href) === here);
  return item ? { section: item.label, label: item.label } : undefined;
});
const navCrumb = $derived.by((): Crumb | undefined => {
  if (shellCrumb) return shellCrumb;
  if (!catalogModel) return undefined;
  const recipe = recipesWithModel.find((r) => recipeState.has(r.id));
  if (!recipe) {
    if (!recipeState.hasFeature(catalogModel.id)) return undefined;
    const renamed =
      cookbookStore.layout?.sections?.[`section:${FEATURE_SECTION.id}`]?.label;
    return {
      section: renamed || FEATURE_SECTION.label,
      label: humanize(catalogModel.name),
      sectionId: `section:${FEATURE_SECTION.id}`,
    };
  }
  const section = navSectionOf(recipe);
  const entry = recipeNav(recipe).find(
    (e) => e.model.id === catalogModel.id && e.key === view,
  );
  const renamed =
    cookbookStore.layout?.sections?.[`section:${section.id}`]?.label;
  return {
    section: renamed || section.label,
    label: entry?.label ?? catalogModel.name,
    sectionId: `section:${section.id}`,
  };
});

/** "Section / Entry" shows the section as a link; one name when both match. */
const sameName = (crumb: Crumb) =>
  crumb.section.trim().toLowerCase() === crumb.label.trim().toLowerCase();
// The list heading: the menu entry's label unless it is only the model's name.
const listTitle = $derived(
  navCrumb &&
    catalogModel &&
    navCrumb.label.toLowerCase() !== humanize(catalogModel.name).toLowerCase()
    ? navCrumb.label
    : undefined,
);

// What New creates, from the menu entry: "Sales Orders" -> "sales order".
// An entry can declare its own noun ("Stock levels" -> "stock entry").
const declaredNoun = $derived(
  recipesWithModel
    .flatMap((r) => recipeNav(r))
    .find((e) => e.model.id === catalogModel?.id && e.key === view && e.noun)
    ?.noun,
);
// A filtered entry lists only its rows; the plain entry gives them up.
const scope = $derived(
  catalogModel
    ? pageScope(
        catalogModel.id,
        view,
        recipeState.ids.flatMap((id) => {
          const recipe = recipes.find((r) => r.id === id);
          return recipe ? recipeNav(recipe) : [];
        }),
      )
    : undefined,
);
const preset = $derived(scopePreset(scope));
const noun = $derived(
  navCrumb ? navNoun(navCrumb.label, declaredNoun) : undefined,
);

// Anchored to this model's fields in the recipe whose Help covers it, when
// that Help lists them (a recipe with no menu entry shows no fields).
const helpAnchor = $derived.by(() => {
  const covering =
    recipesWithModel.find(
      (recipe) =>
        recipe.help &&
        sectionId(recipe) === iconSection &&
        recipeState.has(recipe.id),
    ) ??
    recipesWithModel.find(
      (recipe) => recipe.help && sectionId(recipe) === iconSection,
    );
  if (!covering?.help) return undefined;
  const { glossary } = renderHelp(
    covering.help,
    helpModels(covering, recipeState.rows),
  );
  return glossary.some((entry) => entry.model === modelName)
    ? `${covering.id}-fields-${modelName}`
    : undefined;
});
// Line items and other dependent records live inside their parent's record
// view, filtered to it; they have no list page of their own.
const childTables = $derived.by(() => {
  if (!catalogModel) return [];
  const parentNames = lineageNames(catalog, catalogModel.id);
  return childLinks(catalog, recipes, catalogModel.id).map((link) => {
    const view = recipeState.apply(link.model);
    return {
      model: view.model,
      fields: view.fields,
      fk: link.fk,
      title: childTitle(link.model.name, parentNames),
    };
  });
});
// A child in a recipe without a menu entry (and not added as a feature) is
// reached through its parents, not as a page.
const embeddedIn = $derived.by(() => {
  if (!catalogModel) return [];
  if (hasNavPage(recipes, catalogModel.id)) return [];
  if (recipeState.hasFeature(catalogModel.id)) return [];
  if (!recipesWithModel.length) return [];
  return recipes.flatMap((recipe) =>
    recipeNav(recipe).filter((entry) =>
      childLinks(catalog, [recipe], entry.model.id).some(
        (link) => link.model.id === catalogModel.id,
      ),
    ),
  );
});
const inApp = $derived(
  selection.has(packageId) ||
    (catalogModel ? recipeState.hasFeature(catalogModel.id) : false) ||
    recipesWithModel.some((recipe) => recipeState.has(recipe.id)),
);
</script>

<svelte:head>
  <title>{modelName} · {humanize(packageId)} · smrt planner</title>
</svelte:head>

{#if model && applied}
  <main>
    <div class="bar">
    <nav aria-label="Breadcrumb">
      {#if navCrumb}
        {#if sameName(navCrumb) || !navCrumb.sectionId}
          {navCrumb.label}
        {:else}
          <a href={appHref(sectionPath(navCrumb.sectionId))}>{navCrumb.section}</a>
          / {navCrumb.label}
        {/if}
      {:else}
        {model.name}
      {/if}
      {#if cookbookStore.loaded && !inApp}
        <span class="meta">(not in your app yet)</span>
      {/if}
    </nav>
    {#if iconSection}
      <SectionIcons section={iconSection} label={iconLabel} {helpAnchor} />
    {/if}
    </div>

    {#if embeddedIn.length}
      <p>
        {humanize(model.name)} records live inside their parent record. Open
        one of:
        {#each embeddedIn as entry, i (entry.model.id)}
          {i ? ', ' : ''}<a href={appHref(navPath(entry))}>{entry.label}</a>
        {/each}
      </p>
    {:else if forms.length && model.id === PRODUCT}
      <FormWorkspace
        {model}
        {forms}
        {scope}
        {preset}
        title={listTitle}
        {noun}
      />
    {:else}
      <ModelWorkspace
        {model}
        fields={applied.fields}
        {forms}
        {childTables}
        title={listTitle}
        {noun}
        {scope}
        {preset}
      />
    {/if}
  </main>
{/if}

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  .bar {
    display: flex;
    align-items: center;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
