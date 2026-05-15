<script lang="ts">
/**
 * Harness for asserting that <ToolsDock>'s `context` prop is forwarded into
 * the dock instance reactively — including the case where the initial value
 * is `undefined` and is later populated (async route data), and the case
 * where the prop changes multiple times after mount.
 *
 * Owns a `$state` ref for the current context so that the test can mutate it
 * post-mount via the `setContextProp` callback exposed via `onReady`.
 */
import { defineToolsDock } from '../tools-dock/define-tools-dock.svelte.js';
import ToolsDock from '../tools-dock/ToolsDock.svelte';
import type { ToolsDockContext, ToolsDockInstance } from '../types.js';

interface Props {
  onReady: (api: {
    dock: ToolsDockInstance;
    setContextProp: (next: ToolsDockContext | null | undefined) => void;
  }) => void;
}

const props: Props = $props();

// biome-ignore lint/correctness/noUnusedVariables: noop component
const NoopBody = (() => null) as never;

const dock = defineToolsDock({
  tools: [{ id: 'chat', label: 'Chat', component: NoopBody }],
});

let currentContext = $state<ToolsDockContext | null | undefined>(undefined);

props.onReady({
  dock,
  setContextProp: (next) => {
    currentContext = next;
  },
});
</script>

<ToolsDock {dock} context={currentContext} />
