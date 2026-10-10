<script lang="ts">
import {
  createOverview,
  type OverviewController,
  type OverviewControllerOptions,
} from '../controller.svelte.js';
import type { OverviewGridProps } from '../grid-types.js';
import OverviewGrid from '../OverviewGrid.svelte';

let {
  options,
  gridProps = {},
  onApi,
}: {
  options: OverviewControllerOptions;
  gridProps?: Partial<Omit<OverviewGridProps, 'controller'>>;
  onApi?: (controller: OverviewController) => void;
} = $props();

// The controller is created once; its options are the test's fixture.
// svelte-ignore state_referenced_locally
const controller = createOverview(options);
// svelte-ignore state_referenced_locally
onApi?.(controller);
</script>

<OverviewGrid {controller} {...gridProps} />
