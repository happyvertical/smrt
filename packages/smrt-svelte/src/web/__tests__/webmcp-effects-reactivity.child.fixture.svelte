<script lang="ts">
import { useWebMcpTool } from '../webmcp.svelte.js';

// Declared destructive so it registers only under a Provider policy that
// explicitly allows `destructive` — used to prove a later Provider policy
// change is observed by `useWebMcpTool`'s effect (#2586 F2).
useWebMcpTool(() => ({
  name: 'reactivity_destructive_tool',
  description: 'Destructive bespoke tool for Provider effects reactivity',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: false, destructiveHint: true },
  execute: () => 'destroyed',
}));
</script>

<span>reactivity-destructive-tool</span>
