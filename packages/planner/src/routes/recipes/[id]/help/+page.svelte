<script lang="ts">
import ConnectTools from '$lib/components/ConnectTools.svelte';
import HelpView from '$lib/components/HelpView.svelte';
import { appHref } from '$lib/planner/app.svelte.ts';
import { renderHelp } from '$lib/recipes/help.ts';
import { getRecipe, helpModels, recipeModels } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const recipe = $derived(getRecipe(data.id));
const applied = $derived(recipe ? helpModels(recipe, recipeState.rows) : []);
// Re-rendered whenever the app's options change.
const rendered = $derived(
  recipe?.help ? renderHelp(recipe.help, applied) : undefined,
);
// Surfaces the app's options narrowed off are not listed.
const connect = $derived(
  recipe
    ? recipeModels(recipe).map(({ model }) => recipeState.apply(model).model)
    : [],
);
</script>

<svelte:head>
  <title>{recipe?.label ?? data.id} help · smrt planner</title>
</svelte:head>

{#if recipe}
  <main>
    <header>
      <p class="meta">
        <a href={appHref('/')}>Planner</a> /
        <a href={appHref(`/recipes/${recipe.id}/`)}>{recipe.label}</a> / Help
      </p>
      <h1>{recipe.label} help</h1>
      <p class="meta">{recipe.summary}</p>
    </header>

    {#if rendered}
      <HelpView blocks={rendered.blocks} glossary={rendered.glossary} />
    {:else}
      <p>There is no help for {recipe.label} yet.</p>
    {/if}

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

  h1,
  p {
    margin: 0;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
