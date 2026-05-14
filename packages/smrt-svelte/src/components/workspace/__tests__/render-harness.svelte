<script lang="ts">
/**
 * Render harness — wires defineToolsDock + <ToolsDock> into a single
 * component so tests can render the actual DOM. Accepts a thin shape that
 * lets each test express only the behavior it cares about.
 */
import { onMount } from 'svelte';
import { defineToolsDock } from '../tools-dock/define-tools-dock.svelte.js';
import ToolsDock from '../tools-dock/ToolsDock.svelte';
import type { AvailableTool, ToolsDockContext } from '../types.js';

interface ToolProp {
  id: string;
  label: string;
  badge?: number | string | null;
}

interface Props {
  tools: ToolProp[];
  fetchAvailability?: (
    ctx: ToolsDockContext | null,
  ) => Promise<AvailableTool[]>;
  initialOpen?: boolean;
  layout?: 'rail' | 'topbar';
  /** Activate this tool on mount via dock.open(id). */
  activateOnMount?: string | null;
  /** Call dock.setContext(...) on mount. */
  setContextOnMount?: ToolsDockContext | null;
  /** Force the dock open after setup (for empty-state assertions). */
  forceOpen?: boolean;
}

const props: Props = $props();

// Use a trivial inline component as the tool body; the renderer only checks
// that ActiveTool is defined and renders a header — the body is irrelevant
// for these tests.
// biome-ignore lint/correctness/noUnusedVariables: noop component
const NoopBody = (() => null) as never;

const dock = defineToolsDock({
  tools: props.tools.map((t) => ({ ...t, component: NoopBody })),
  fetchAvailability: props.fetchAvailability,
  initialOpen: props.initialOpen,
  layout: props.layout,
});

onMount(() => {
  if (props.setContextOnMount !== undefined) {
    dock.setContext(props.setContextOnMount);
  }
  if (props.activateOnMount) {
    dock.open(props.activateOnMount);
  }
  if (props.forceOpen) {
    dock.open();
  }
});
</script>

<ToolsDock {dock} />
