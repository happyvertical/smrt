<script lang="ts">
import { getModel } from '$lib/catalog/index.ts';
import FormWorkspace from '$lib/components/FormWorkspace.svelte';
import ModelWorkspace from '$lib/components/ModelWorkspace.svelte';
import SectionIcons from '$lib/components/SectionIcons.svelte';
import { humanize } from '$lib/data/format.ts';
import { activeForms } from '$lib/forms/active.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import { selection } from '$lib/planner/selection.svelte.ts';
import { recipes, sectionId } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const catalogModel = $derived(getModel(data.packageId, data.modelName));
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
// Anchored to this model's fields in the recipe whose Help covers it.
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
  return covering ? `${covering.id}-fields-${data.modelName}` : undefined;
});
const inApp = $derived(
  selection.has(data.packageId) ||
    recipesWithModel.some((recipe) => recipeState.has(recipe.id)),
);
</script>

<svelte:head>
  <title>{data.modelName} · {humanize(data.packageId)} · smrt planner</title>
</svelte:head>

{#if model && applied}
  <main>
    <div class="bar">
    <nav aria-label="Breadcrumb">
      <a href={appHref('/')}>Planner</a>
      / <a href={appHref(`/packages/${data.packageId}/`)}>{humanize(data.packageId)}</a>
      / {model.name}
      {#if !inApp}
        <span class="meta">(not in your app yet)</span>
      {/if}
    </nav>
    {#if iconSection}
      <SectionIcons section={iconSection} label={iconLabel} {helpAnchor} />
    {/if}
    </div>

    {#if forms.length}
      <FormWorkspace {model} {forms} />
    {:else}
      <ModelWorkspace {model} fields={applied.fields} />
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
