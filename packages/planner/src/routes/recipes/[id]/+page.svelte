<script lang="ts">
import RecipeOptions from '$lib/components/RecipeOptions.svelte';
import SectionIcons from '$lib/components/SectionIcons.svelte';
import { appHref } from '$lib/planner/app.svelte.ts';
import { getSection } from '$lib/recipes/index.ts';
import type { PageProps } from './$types';

// `id` is the section id: a recipe id, or the group id of several recipes.
let { data }: PageProps = $props();

const section = $derived(getSection(data.id));
</script>

<svelte:head>
  <title>{section?.label ?? data.id} options · smrt planner</title>
</svelte:head>

{#if section}
  <main>
    <header>
      <div class="bar">
        <p class="meta"><a href={appHref('/')}>Planner</a> / {section.label} options</p>
        <SectionIcons section={section.id} label={section.label} current="options" />
      </div>
      <h1>{section.label} options</h1>
    </header>

    {#each section.recipes as recipe (recipe.id)}
      <RecipeOptions {recipe} titled={section.recipes.length > 1} />
    {/each}
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
