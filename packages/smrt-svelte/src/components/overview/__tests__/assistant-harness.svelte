<script lang="ts">
import {
  createOverviewAssistant,
  type OverviewAssistant,
  type OverviewAssistantOptions,
} from '../assistant.svelte.js';
import {
  createOverview,
  type OverviewControllerOptions,
} from '../controller.svelte.js';
import OverviewAssistantUndo from '../OverviewAssistantUndo.svelte';
import OverviewGrid from '../OverviewGrid.svelte';

let {
  options,
  assistantOptions = {},
  onApi,
}: {
  options: OverviewControllerOptions;
  assistantOptions?: OverviewAssistantOptions;
  onApi?: (assistant: OverviewAssistant) => void;
} = $props();

// Created once from the test's fixture.
// svelte-ignore state_referenced_locally
const controller = createOverview(options);
// svelte-ignore state_referenced_locally
const assistant = createOverviewAssistant(controller, assistantOptions);
// svelte-ignore state_referenced_locally
onApi?.(assistant);
</script>

<OverviewAssistantUndo {assistant} />
<OverviewGrid {controller} editing={false} />
