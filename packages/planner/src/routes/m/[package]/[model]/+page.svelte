<script lang="ts">
import { getModel } from '$lib/catalog/index.ts';
import ModelWorkspace from '$lib/components/ModelWorkspace.svelte';
import SurfacePanel from '$lib/components/SurfacePanel.svelte';
import { humanize } from '$lib/data/format.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import { selection } from '$lib/planner/selection.svelte.ts';
import { recipes } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const catalogModel = $derived(getModel(data.packageId, data.modelName));
// Recipe options (field policies, narrowed exposure) shape what is shown.
const applied = $derived(
  catalogModel ? recipeState.apply(catalogModel) : undefined,
);
const model = $derived(applied?.model);
const recipesWithModel = $derived(
  recipes.filter(
    (recipe) => catalogModel && recipe.models.includes(catalogModel.id),
  ),
);
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
    <nav aria-label="Breadcrumb">
      <a href={appHref('/')}>Planner</a>
      / <a href={appHref(`/packages/${data.packageId}/`)}>{humanize(data.packageId)}</a>
      / {model.name}
      {#if !inApp}
        <span class="meta">(not in your app yet)</span>
      {/if}
    </nav>

    <ModelWorkspace {model} fields={applied.fields} />

    <SurfacePanel models={[model]} fields={{ [model.id]: applied.fields }} />
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

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
