<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { getContext } from 'svelte';
import { aiState } from '$lib/ai/instance.ts';
import AiSetup from '$lib/components/AiSetup.svelte';
import { appHref } from '$lib/planner/app.svelte.ts';
import PlannerControls from '$lib/planner/PlannerControls.svelte';
import { currentPlannerTitle } from '$lib/planner/title.svelte.ts';
import type { PlannerProjectPersistence } from '$lib/planner/types.ts';
import { PROJECT_PERSISTENCE_CONTEXT } from '$lib/planner/workspace.svelte.ts';

const persistenceOwner = getContext<
  { readonly current: PlannerProjectPersistence | null } | undefined
>(PROJECT_PERSISTENCE_CONTEXT);
const title = $derived(currentPlannerTitle());
</script>

<svelte:head>
  <title>{title} · smrt planner</title>
</svelte:head>

<main>
  {#if aiState.firstRun}
    <section class="smrt-planner-page__first-run" aria-labelledby="first-run-title" data-smrt-part="panel">
      <h1 id="first-run-title">Set up your assistant</h1>
      <p class="smrt-planner-page__meta" data-smrt-part="meta">{aiState.privacyNote}</p>
      <AiSetup />
      <div class="smrt-planner-page__actions" data-smrt-part="actions">
        <Button onclick={() => aiState.continueFirstRun()}>
          Continue
        </Button>
        <Button variant="secondary" onclick={() => aiState.dismissFirstRun()}>
          I don't need AI, let's just build
        </Button>
      </div>
    </section>
  {:else}
  <PlannerControls projectPersistence={persistenceOwner?.current ?? null} nativeAssistant={aiState.session.transport} layout="shell" persistence="host" themeControls advancedStylesHref={appHref('/advanced-styles/')} />
  {/if}
</main>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  main {
    width: min(100%, 72rem);
    margin-inline: auto;
    padding: var(--smrt-spacing-6);
  }
  .smrt-planner-page__first-run {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  .smrt-planner-page__first-run h1,
  .smrt-planner-page__first-run p {
    margin: 0;
  }
  .smrt-planner-page__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }
}

@layer smrt.theme {
}

</style>
