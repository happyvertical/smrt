<script lang="ts">
import { useWebMcpTool } from '../webmcp.svelte.js';

let { version = 1 }: { version?: number } = $props();

useWebMcpTool(() => ({
  name: `harness_tool_${version}`,
  description: 'A lifecycle test tool',
  inputSchema: { type: 'object' },
  // Declared read-only so this lifecycle fixture registers under the
  // registrar's default read-only exposure policy (#2586). An undeclared
  // bespoke tool is excluded by default — see the "unannotated" test below.
  annotations: { readOnlyHint: true },
  execute: () => String(version),
}));
</script>

<span>{version}</span>
