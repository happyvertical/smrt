<script lang="ts">
  import { EmptyState } from '@happyvertical/smrt-ui/layout';
</script>

<svelte:head>
  <title>Home</title>
</svelte:head>

<main class="smrt-template-home__root">
  <h1>Home</h1>
  <EmptyState
    title="Nothing here yet"
    description="Add your first object in src/lib/objects, then build pages for it here."
  />
</main>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-template-home__root {
    width: min(100%, 48rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6) var(--smrt-spacing-4);
  }
  h1 {
    margin: 0 0 var(--smrt-spacing-4);
  }
}

@layer smrt.theme {
}

</style>
