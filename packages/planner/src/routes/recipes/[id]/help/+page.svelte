<script lang="ts">
import ConnectTools from '$lib/components/ConnectTools.svelte';
import RecipeHelp from '$lib/components/RecipeHelp.svelte';
import SectionIcons from '$lib/components/SectionIcons.svelte';
import { appHref } from '$lib/planner/app.svelte.ts';
import { getSection, recipeModels } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { PageProps } from './$types';

// `id` is the section id: a recipe id, or the group id of several recipes.
let { data }: PageProps = $props();

const section = $derived(getSection(data.id));
// Surfaces the app's options narrowed off are not listed; a model two recipes
// share (Product) is listed once.
const connect = $derived.by(() => {
  const seen = new Set<string>();
  return (section?.recipes ?? []).flatMap((recipe) =>
    recipeModels(recipe).flatMap(({ model }) => {
      if (seen.has(model.id)) return [];
      seen.add(model.id);
      return [recipeState.apply(model).model];
    }),
  );
});
</script>

<svelte:head>
  <title>{section?.label ?? data.id} help · smrt planner</title>
</svelte:head>

{#if section}
  <main>
    <header>
      <div class="bar">
        <p class="meta">
          <a href={appHref('/')}>Planner</a> /
          <a href={appHref(`/recipes/${section.id}/`)}>{section.label}</a> / Help
        </p>
        <SectionIcons section={section.id} label={section.label} current="help" />
      </div>
      <h1>{section.label} help</h1>
    </header>

    {#each section.recipes as recipe (recipe.id)}
      <RecipeHelp {recipe} titled={section.recipes.length > 1} />
    {/each}

    <ConnectTools models={connect} />
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

  header {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .bar {
    display: flex;
    align-items: center;
  }

  h1,
  p {
    margin: 0;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
