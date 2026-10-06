<script lang="ts">
import { humanize } from '$lib/data/format.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import { recipePackage, recipes } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';

let notice = $state('');

const label = (id: string) =>
  recipes.find((recipe) => recipe.id === id)?.label ?? id;

// Adding stays on the Planner: the recipe appears in the menu to explore
// whenever the visitor likes, and the status line announces what was added.
function add(id: string) {
  const before = new Set(recipeState.ids);
  recipeState.add(id);
  const added = recipeState.ids.filter((x) => !before.has(x)).map(label);
  notice = `Added ${added.join(' and ')} to the menu.`;
}

function remove(id: string) {
  recipeState.remove(id);
  notice = `Removed ${label(id)}.`;
}
</script>

<svelte:head>
  <title>Planner · smrt planner</title>
</svelte:head>

<main>
  <header>
    <h1>Plan your app</h1>
    <p>
      Add recipes, small units of an app like Customers or Sales, and the app
      assembles around them: navigation, list and edit views with sample data,
      and the REST routes, MCP tools and CLI commands s-m-r-t generates. Each
      recipe has an options form built from its models' own parameters. Your
      picks live in the URL, so you can share the mock-up.
    </p>
    <p><a href={appHref('/packages/')}>All packages</a></p>
  </header>

  <section aria-label="Your recipes" class="selection">
    <h2>Your app</h2>
    {#if recipeState.ids.length === 0}
      <p>Nothing added yet. Choose a recipe below.</p>
    {:else}
      <ul class="chips">
        {#each recipeState.ids as id (id)}
          <li><a href={appHref(`/recipes/${id}/`)}>{label(id)}</a></li>
        {/each}
      </ul>
      <button type="button" class="secondary" onclick={() => recipeState.clear()}>
        Clear recipes
      </button>
    {/if}
    <p class="notice" role="status" aria-live="polite">{notice}</p>
  </section>

  <section aria-label="Recipes">
    <h2>Recipes <small>{recipes.length}</small></h2>
    <ul class="cards">
      {#each recipes as recipe (recipe.id)}
        {@const added = recipeState.has(recipe.id)}
        {@const neededBy = recipeState.requiredBy(recipe.id)}
        {@const pkg = recipePackage(recipe)}
        <li class:selected={added}>
          <h3><a href={appHref(`/recipes/${recipe.id}/`)}>{recipe.label}</a></h3>
          <p class="description">{recipe.summary}</p>
          <p class="meta">
            <code>{recipe.id}</code> · from {pkg ? humanize(pkg.id) : 'unknown package'}
          </p>
          {#if recipe.requires.length}
            <p class="meta">Needs: {recipe.requires.map(label).join(', ')}</p>
          {/if}
          {#if added}
            <p class="meta">
              {neededBy.length
                ? `In your app (needed by ${neededBy.map(label).join(', ')})`
                : 'In your app'}
            </p>
          {/if}
          <div class="actions">
            {#if added}
              <a class="button" href={appHref(`/recipes/${recipe.id}/`)}>Options</a>
            {/if}
            <button
              type="button"
              class:secondary={added}
              disabled={neededBy.length > 0}
              onclick={() => (added ? remove(recipe.id) : add(recipe.id))}
            >
              {added ? `Remove ${recipe.label}` : `Add ${recipe.label} to my app`}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  </section>
</main>

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-6);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  header,
  .selection {
    display: grid;
    gap: var(--smrt-spacing-2);
    justify-items: start;
  }

  header p,
  .meta,
  .description,
  small {
    color: var(--smrt-color-on-surface-variant);
  }

  small {
    font-weight: 400;
  }

  .chips,
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chips a {
    display: inline-block;
    padding: var(--smrt-spacing-1) var(--smrt-spacing-3);
    border-radius: var(--smrt-radius-large);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    text-decoration: none;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  }

  .cards li {
    display: grid;
    align-content: start;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-large);
  }

  .cards li.selected {
    border-color: var(--smrt-color-primary);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2);
  }

  button,
  .button {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 0;
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: inherit;
    text-decoration: none;
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
