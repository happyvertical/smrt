<script lang="ts">
import AiSetup from '$lib/components/AiSetup.svelte';
import { appHref } from '$lib/planner/app.svelte.ts';
</script>

<svelte:head>
  <title>AI models · smrt planner</title>
</svelte:head>

<main>
  <p class="meta"><a href={appHref('/')}>Planner</a> / AI models</p>
  <h1>Set up your assistant</h1>
  <p class="privacy">
    Everything runs on this device. Nothing you type or say leaves the page.
  </p>
  <AiSetup />
</main>

<style>
  main {
    display: grid;
    gap: var(--smrt-spacing-4);
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  h1,
  p {
    margin: 0;
  }

  .meta,
  .privacy {
    color: var(--smrt-color-on-surface-variant);
  }
</style>
