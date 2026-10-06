<script lang="ts">
import { humanize } from '$lib/data/format.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import {
  getRecipe,
  recipeModels,
  recipeNav,
  recipePackage,
  sectionId,
} from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { Recipe } from '$lib/recipes/types.ts';
import ModelOptions from './ModelOptions.svelte';

interface RecipeOptionsProps {
  recipe: Recipe;
  /** Show the recipe's own heading: set when the page lists several recipes. */
  titled?: boolean;
}

let { recipe, titled = false }: RecipeOptionsProps = $props();

const added = $derived(recipeState.has(recipe.id));
const neededBy = $derived(recipeState.requiredBy(recipe.id));
const models = $derived(recipeModels(recipe));
const label = (id: string) => getRecipe(id)?.label ?? id;
const requiredHref = (id: string) => {
  const required = getRecipe(id);
  return appHref(`/recipes/${required ? sectionId(required) : id}/`);
};
</script>

<section class="recipe" aria-label={recipe.label}>
  <header>
    {#if titled}<h2>{recipe.label}</h2>{/if}
    <p>{recipe.summary}</p>
    <p class="meta">
      <code>{recipe.id}</code> · from
      {recipePackage(recipe) ? humanize(recipePackage(recipe)?.id ?? '') : 'unknown package'}
    </p>
    {#if recipe.requires.length}
      <p class="meta">
        Needs:
        {#each recipe.requires as required, i (required)}
          {#if i > 0},
          {/if}<a href={requiredHref(required)}>{label(required)}</a>
        {/each}
      </p>
    {/if}
    <div class="actions">
      <button
        type="button"
        class:secondary={added}
        disabled={neededBy.length > 0}
        onclick={() =>
          added ? recipeState.remove(recipe.id) : recipeState.add(recipe.id)}
      >
        {neededBy.length
          ? `Remove ${recipe.label} (needed by ${neededBy.map(label).join(', ')})`
          : added
            ? `Remove ${recipe.label} from my app`
            : `Add ${recipe.label} to my app`}
      </button>
    </div>
  </header>

  <div class="adds">
    <h3>What it adds</h3>
    <ul>
      {#each recipeNav(recipe) as entry (entry.model.id)}
        <li>
          {#if added}
            <a href={appHref(`/m/${entry.packageId}/${entry.model.name}/`)}>{entry.label}</a>
          {:else}
            {entry.label}
          {/if}
          <span class="meta">list, create, edit and delete views for {entry.model.name}</span>
        </li>
      {/each}
    </ul>
  </div>

  {#if added}
    <div class="options">
      <h3>Options</h3>
      <p class="meta">
        Generated from the parameters {recipe.label}'s models declare. Saving
        writes field policies, held in memory for now.
      </p>
      {#each models as { model } (model.id)}
        <ModelOptions {model} hints={recipe.options?.[model.id]} />
      {/each}
    </div>
  {:else}
    <p class="meta">Add this recipe to set its options.</p>
  {/if}
</section>

<style>
  .recipe,
  header,
  .adds,
  .options {
    display: grid;
    gap: var(--smrt-spacing-3);
    justify-items: start;
  }

  .options {
    justify-items: stretch;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }

  ul {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin: 0;
    padding-left: var(--smrt-spacing-5);
  }

  button {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 0;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
    cursor: pointer;
  }

  button.secondary {
    border: 1px solid var(--smrt-color-outline);
    background: transparent;
    color: var(--smrt-color-on-surface);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
