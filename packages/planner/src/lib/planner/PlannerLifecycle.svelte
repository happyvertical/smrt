<script lang="ts">
import { onMount } from 'svelte';
import { aiState } from '../ai/instance.ts';
import { browserStorage } from '../cookbook/storage.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { provideDataSource, tryUseDataSource } from '../data/context.ts';
import { createPlannerDataSource } from '../data/planner-source.ts';
import { configFromProp } from '../inference/config.ts';
import { libraryState } from '../library/state.svelte.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { type LinkMode, setBasePath } from './app.svelte.ts';
import { createPlannerAssistant } from './assistant.ts';
import { plannerController, plannerRuntime } from './instance.ts';
import type { PlannerProps } from './types.ts';

let {
  controller = plannerController,
  basePath,
  inference,
  persistence = 'self',
  onready,
  links = 'path',
}: Pick<
  PlannerProps,
  'controller' | 'basePath' | 'inference' | 'persistence' | 'onready'
> & {
  /** `'hash'` in the complete `Planner`, whose pages are fragment routes. */
  links?: LinkMode;
} = $props();

const dataSource =
  tryUseDataSource() ?? provideDataSource(createPlannerDataSource());

$effect.pre(() => {
  if (basePath !== undefined || links !== 'path') {
    setBasePath(basePath ?? '', links);
  }
});

onMount(() => {
  const previous = plannerRuntime.onReplaced;
  plannerRuntime.onReplaced = () => dataSource.reset?.();
  if (persistence === 'self' && !cookbookStore.loaded) {
    libraryState.load();
    cookbookStore.hydrate('', browserStorage());
  }
  const assistant = inference
    ? createPlannerAssistant(controller, inference)
    : undefined;
  // The complete Planner's own dock and AI models page read `aiState`, the
  // store the static app configures from `planner.config.json`; a mount
  // configures it from the prop instead (the prop wins, as documented).
  if (inference) {
    if ('chat' in inference) aiState.useChat(inference.chat, 'Host model');
    else aiState.configure(configFromProp(inference));
    aiState.hydrate(
      recipeState.ids.length > 0 || recipeState.features.length > 0,
    );
  }
  onready?.({ controller, ...(assistant ? { assistant } : {}) });
  return () => {
    plannerRuntime.onReplaced = previous;
  };
});

$effect(() => {
  if (persistence !== 'self') return;
  void JSON.stringify(cookbookStore.snapshot());
  cookbookStore.scheduleSave();
});
</script>

<svelte:window onpagehide={() => persistence === 'self' && cookbookStore.flush()} />
