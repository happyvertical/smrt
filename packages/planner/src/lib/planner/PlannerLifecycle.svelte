<script lang="ts">
import { onMount } from 'svelte';
import { browserStorage } from '../cookbook/storage.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { provideDataSource, tryUseDataSource } from '../data/context.ts';
import { createPlannerDataSource } from '../data/planner-source.ts';
import { libraryState } from '../library/state.svelte.ts';
import { setBasePath } from './app.svelte.ts';
import { createPlannerAssistant } from './assistant.ts';
import { plannerController, plannerRuntime } from './instance.ts';
import type { PlannerProps } from './types.ts';

let {
  controller = plannerController,
  basePath,
  inference,
  persistence = 'self',
  onready,
}: Pick<
  PlannerProps,
  'controller' | 'basePath' | 'inference' | 'persistence' | 'onready'
> = $props();

const dataSource =
  tryUseDataSource() ?? provideDataSource(createPlannerDataSource());

$effect.pre(() => {
  if (basePath !== undefined) setBasePath(basePath);
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
