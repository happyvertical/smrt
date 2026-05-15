<script lang="ts">
/**
 * Provider + consumer in one component. The factory call sets context on
 * this component; an immediate-child snippet then reads it via useToolsDock.
 */
import { defineToolsDock } from '../tools-dock/define-tools-dock.svelte.js';
import { useToolsDock } from '../tools-dock/use-tools-dock.js';
import type { ToolsDockApi } from '../types.js';

interface Props {
  onReady: (api: ToolsDockApi) => void;
}

const { onReady }: Props = $props();
defineToolsDock({
  tools: [{ id: 'demo', label: 'Demo', component: (() => null) as never }],
});
// useToolsDock reads from the same component init scope's context tree.
const api = useToolsDock();
onReady(api);
</script>
