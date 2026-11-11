<script lang="ts" generics="Definitions extends object">
import type { ScreenCollectionDefinition } from '@happyvertical/smrt-svelte/screens';
import {
  createRecipeScreenReferences,
  createRecipeScreenEntry as entryRecords,
  RecipeScreens,
} from '@happyvertical/smrt-svelte/screens';
import type { loadCookbookModelPage } from '@happyvertical/smrt-template-sveltekit/host/server';

interface Props {
  data: Awaited<ReturnType<typeof loadCookbookModelPage>> & {
    dynamicDefinitions: Array<ScreenCollectionDefinition & { name: string }>;
    enabledModels: string[];
  };
  collectionDefinitions: Definitions & {
    [Key in keyof Definitions]: ScreenCollectionDefinition;
  };
}
let { data, collectionDefinitions }: Props = $props();

// The generated web definition of the entry's model and a source over its
// `/api/<collection>` routes. `@smrt/web` covers the cookbook's package models,
// which the `smrt()` preset hosts; a model the API does not expose has no
// definition and gets the notice below.
const definitions = $derived.by(() => {
  const merged: Record<string, ScreenCollectionDefinition> = Object.fromEntries(
    Object.entries(collectionDefinitions) as Array<
      [string, ScreenCollectionDefinition]
    >,
  );
  for (const definition of data.dynamicDefinitions)
    merged[definition.name] = definition;
  return Object.fromEntries(
    Object.entries(merged).filter(([, definition]) =>
      data.enabledModels.includes(definition.objectRef),
    ),
  );
});
const records = $derived(entryRecords(definitions, data.entry));
const references = $derived(
  createRecipeScreenReferences(definitions, {
    hrefFor: (definition, id) =>
      data.referenceHrefs[definition.objectRef]
        ? `${data.referenceHrefs[definition.objectRef]}?record=${encodeURIComponent(id)}`
        : undefined,
  }),
);
</script>

<svelte:head><title>{data.entry.label}</title></svelte:head>

<main data-smrt-component="CookbookModelPage">
  {#if records}
    {#key data.entry.id}
      <RecipeScreens definition={records.definition} source={records.source} entryId={data.entry.id} title={data.entry.label} {definitions} {references} view={data.recordId ? 'view' : 'list'} recordId={data.recordId} />
    {/key}
  {:else}
    <h1>{data.entry.label}</h1>
    <p>
      {data.entry.className} is not exposed over this app's API, so there
      are no record screens for it.
    </p>
  {/if}
</main>

<style>
  main {
    padding: var(--smrt-spacing-6);
  }
</style>
