<script lang="ts">
import { useWebMcpTool } from '../webmcp.svelte.js';

let { version = 1 }: { version?: number } = $props();

useWebMcpTool(() => ({
  name: `harness_tool_${version}`,
  description: 'A lifecycle test tool',
  inputSchema: { type: 'object' },
  execute: () => String(version),
}));
</script>

<span>{version}</span>
