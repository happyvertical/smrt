<script lang="ts">
import { renderHelp } from '../recipes/help.ts';
import { helpModels } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import type { Recipe } from '../recipes/types.ts';
import HelpView from './HelpView.svelte';

interface RecipeHelpProps {
  recipe: Recipe;
  /** Show the recipe's own heading: set when the page lists several recipes. */
  titled?: boolean;
}

let { recipe, titled = false }: RecipeHelpProps = $props();

const applied = $derived(helpModels(recipe, recipeState.rows));
// Re-rendered whenever the app's options change.
const rendered = $derived(
  recipe.help ? renderHelp(recipe.help, applied) : undefined,
);
</script>

<section aria-label={recipe.label}>
  {#if titled}
    <h2 id={`help-${recipe.id}`}>{recipe.label}</h2>
    <p class="meta">{recipe.summary}</p>
  {/if}
  {#if rendered}
    <HelpView
      blocks={rendered.blocks}
      glossary={rendered.glossary}
      idPrefix={`${recipe.id}-`}
    />
  {:else}
    <p>There is no help for {recipe.label} yet.</p>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  h2,
  p {
    margin: 0;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
