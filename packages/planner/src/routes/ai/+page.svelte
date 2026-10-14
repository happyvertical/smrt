<script lang="ts">
import AiModelsPage from '$lib/components/AiModelsPage.svelte';
import { appHref } from '$lib/planner/app.svelte.ts';
</script>

<svelte:head>
  <title>AI models · smrt planner</title>
</svelte:head>

<main>
  <AiModelsPage backHref={appHref('/')} />
</main>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  main {
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }
}
</style>
