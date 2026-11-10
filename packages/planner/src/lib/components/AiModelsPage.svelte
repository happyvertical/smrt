<script lang="ts">
// The AI models page ("Set up your assistant"): the static app serves it at
// `/ai/`, a mounted `Planner` at `#/ai/`. Both render this.
import { aiState } from '../ai/instance.ts';
import AiSetup from './AiSetup.svelte';

interface AiModelsPageProps {
  /** Where the breadcrumb's "Planner" leads. */
  backHref: string;
}

let { backHref }: AiModelsPageProps = $props();
</script>

<div class="ai-page">
  <p class="meta"><a href={backHref}>Planner</a> / AI models</p>
  <h1>Set up your assistant</h1>
  <p class="privacy">{aiState.privacyNote}</p>
  <AiSetup />
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .ai-page {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  h1,
  p {
    margin: 0;
  }

  .meta,
  .privacy {
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
