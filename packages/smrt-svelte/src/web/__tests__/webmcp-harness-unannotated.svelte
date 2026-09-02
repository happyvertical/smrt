<script lang="ts">
import { useWebMcpTool } from '../webmcp.svelte.js';

// No `annotations`: fail-closed classifies this destructive, so it must be
// excluded under the registrar's default read-only exposure policy (#2586).
useWebMcpTool(() => ({
  name: 'harness_tool_unannotated',
  description: 'A lifecycle test tool with no declared effect',
  inputSchema: { type: 'object' },
  execute: () => 'unannotated',
}));
</script>

<span>unannotated</span>
