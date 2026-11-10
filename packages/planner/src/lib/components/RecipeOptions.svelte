<script lang="ts">
import { humanize } from '../data/format.ts';
import { appHref } from '../planner/app.svelte.ts';
import {
  getRecipe,
  navPath,
  recipeModels,
  recipeNav,
  recipePackage,
  sectionId,
} from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import type { Recipe } from '../recipes/types.ts';
import ModelOptions from './ModelOptions.svelte';

interface RecipeOptionsProps {
  recipe: Recipe;
  /** Show the recipe's own heading: set when the page lists several recipes. */
  titled?: boolean;
}

let { recipe, titled = false }: RecipeOptionsProps = $props();

// Under the page's h1: a titled recipe is an h2 with its parts at h3, an
// untitled one has its parts at h2.
const part = $derived(titled ? 'h3' : 'h2');
const added = $derived(recipeState.has(recipe.id));
const neededBy = $derived(recipeState.requiredBy(recipe.id));
const models = $derived(recipeModels(recipe));
const label = (id: string) => getRecipe(id)?.label ?? id;
const requiredHref = (id: string) => {
  const required = getRecipe(id);
  return appHref(`/recipes/${required ? sectionId(required) : id}/`);
};
</script>

<section class="smrt-recipe-options__root" aria-label={recipe.label} data-smrt-component="RecipeOptions">
  <header>
    {#if titled}<h2>{recipe.label}</h2>{/if}
    <p>{recipe.summary}</p>
    <p class="smrt-recipe-options__meta" data-smrt-part="meta">
      <code>{recipe.id}</code> · from
      {recipePackage(recipe) ? humanize(recipePackage(recipe)?.id ?? '') : 'unknown package'}
    </p>
    {#if recipe.requires.length}
      <p class="smrt-recipe-options__meta" data-smrt-part="meta">
        Needs:
        {#each recipe.requires as required, i (required)}
          {#if i > 0},
          {/if}<a href={requiredHref(required)}>{label(required)}</a>
        {/each}
      </p>
    {/if}
    <div class="smrt-recipe-options__actions" data-smrt-part="actions">
      <button
        type="button"
        class:smrt-recipe-options__secondary={added}
        data-smrt-part="action"
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

  <div class="smrt-recipe-options__adds" data-smrt-part="list">
    <svelte:element this={part}>What it adds</svelte:element>
    <ul>
      {#each recipeNav(recipe) as entry (entry.model.id)}
        <li>
          {#if added}
            <a href={appHref(navPath(entry))}>{entry.label}</a>
          {:else}
            {entry.label}
          {/if}
          <span class="smrt-recipe-options__meta" data-smrt-part="meta">list, create, edit and delete views for {entry.model.name}</span>
        </li>
      {/each}
    </ul>
  </div>

  {#if added}
    <div class="smrt-recipe-options__options" data-smrt-part="panel">
      <svelte:element this={part}>Options</svelte:element>
      <p class="smrt-recipe-options__meta" data-smrt-part="meta">
        Generated from the parameters {recipe.label}'s models declare. Saving
        writes field policies, held in memory for now.
      </p>
      {#each models as { model } (model.id)}
        <ModelOptions
          {model}
          hints={recipe.options?.[model.id]}
          headingLevel={titled ? 4 : 3}
        />
      {/each}
    </div>
  {:else}
    <p class="smrt-recipe-options__meta" data-smrt-part="meta">Add this recipe to set its options.</p>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-recipe-options__root,
  header,
  .smrt-recipe-options__adds,
  .smrt-recipe-options__options {
    display: grid;
    gap: var(--smrt-spacing-3);
    justify-items: start;
  }
  .smrt-recipe-options__options {
    justify-items: stretch;
  }
  h2,
  h3,
  p,
  .smrt-recipe-options__adds > :first-child,
  .smrt-recipe-options__options > :first-child {
    margin: 0;
  }
  ul {
    display: grid;
    gap: var(--smrt-spacing-1);
    margin: 0;
    padding-left: var(--smrt-spacing-5);
  }
  button {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    cursor: pointer;
  }
  button:disabled {
    cursor: not-allowed;
  }
}

@layer smrt.theme {
  .smrt-recipe-options__meta {
    color: var(--smrt-color-on-surface-variant);
  }
  button {
    border: 0;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
  }
  button.smrt-recipe-options__secondary {
    border: var(--smrt-control-border);
    background: transparent;
    color: var(--smrt-color-on-surface);
  }
  /* Decorative dimming of a disabled control; forced colours express it as
  GrayText instead, so the dimming is dropped there. */
  button:disabled {
    opacity: 0.6;
  }
  /* Forced colours: a disabled button reads as GrayText, not by opacity. */
  @media (forced-colors: active) {
    button:disabled {
      border-color: GrayText;
      color: GrayText;
      opacity: 1;
    }
  }
}

</style>
