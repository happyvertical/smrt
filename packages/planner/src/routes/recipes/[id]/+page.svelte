<script lang="ts">
import ModelOptions from '$lib/components/ModelOptions.svelte';
import SurfacePanel from '$lib/components/SurfacePanel.svelte';
import { humanize } from '$lib/data/format.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import {
  getRecipe,
  recipeModels,
  recipeNav,
  recipePackage,
} from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const recipe = $derived(getRecipe(data.id));
const added = $derived(recipeState.has(data.id));
const neededBy = $derived(recipeState.requiredBy(data.id));
const models = $derived(recipe ? recipeModels(recipe) : []);
const applied = $derived(models.map(({ model }) => recipeState.apply(model)));
const fields = $derived(
  Object.fromEntries(applied.map((a) => [a.model.id, a.fields])),
);
const label = (id: string) => getRecipe(id)?.label ?? id;
</script>

<svelte:head>
  <title>{recipe?.label ?? data.id} · recipes · smrt planner</title>
</svelte:head>

{#if recipe}
  <main>
    <header>
      <p class="meta"><a href={appHref('/')}>Planner</a> / {recipe.label}</p>
      <h1>{recipe.label}</h1>
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
            {/if}<a href={appHref(`/recipes/${required}/`)}>{label(required)}</a>
          {/each}
        </p>
      {/if}
      <div class="actions">
        {#if added}
          <button
            type="button"
            class="secondary"
            disabled={neededBy.length > 0}
            aria-label={`Remove ${recipe.label} from my app`}
            onclick={() => recipeState.remove(recipe.id)}
          >
            {neededBy.length
              ? `In your app (needed by ${neededBy.map(label).join(', ')})`
              : 'Remove from my app'}
          </button>
        {:else}
          <button
            type="button"
            aria-label={`Add ${recipe.label} to my app`}
            onclick={() => recipeState.add(recipe.id)}
          >
            Add to my app
          </button>
        {/if}
      </div>
    </header>

    <section>
      <h2>What it adds</h2>
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
    </section>

    {#if added}
      <section aria-label="Options">
        <h2>Options</h2>
        <p class="meta">
          Generated from the parameters {recipe.label}'s models declare. Saving
          writes field policies, held in memory for now.
        </p>
        {#each models as { model } (model.id)}
          <ModelOptions {model} hints={recipe.options?.[model.id]} />
        {/each}
      </section>

      <SurfacePanel models={applied.map((a) => a.model)} {fields} />
    {:else}
      <p class="meta">Add this recipe to set its options and see what you get.</p>
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

  header,
  section {
    display: grid;
    gap: var(--smrt-spacing-3);
    justify-items: start;
  }

  section[aria-label='Options'] {
    justify-items: stretch;
  }

  h1,
  h2,
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
