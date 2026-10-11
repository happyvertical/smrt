<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { aiState } from '$lib/ai/instance.ts';
import AiSetup from '$lib/components/AiSetup.svelte';
import Planner from '$lib/planner/Planner.svelte';
</script>

<svelte:head>
  <title>Planner · smrt planner</title>
</svelte:head>

<main>
  {#if aiState.firstRun}
    <section class="first-run" aria-labelledby="first-run-title">
      <h1 id="first-run-title">Set up your assistant</h1>
      <p class="meta">{aiState.privacyNote}</p>
      <AiSetup />
      <div class="actions">
        <Button onclick={() => aiState.continueFirstRun()}>
          Continue
        </Button>
        <Button variant="secondary" onclick={() => aiState.dismissFirstRun()}>
          I don't need AI, let's just build
        </Button>
      </div>
    </section>
  {:else}
  <Planner layout="shell" persistence="host" themeControls />
  {/if}
</main>

<style>
  main {
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }

  .first-run {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .first-run h1,
  .first-run p {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }
</style>
