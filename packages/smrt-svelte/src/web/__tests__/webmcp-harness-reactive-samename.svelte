<script lang="ts">
import { useWebMcpTool } from '../webmcp.svelte.js';

// Same registered NAME on every render; only `description` changes, so each
// prop change still replaces the spec object and reruns useWebMcpTool's
// effect (#2586 F2's reactive `bespokeContext.effects` read applies to any
// reactive spec, not only one driven by Provider policy) while exercising
// same-name re-registration serialization.
let { version = 1 }: { version?: number } = $props();

useWebMcpTool(() => ({
  name: 'harness_reactive_tool',
  description: `Reactive tool v${version}`,
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  execute: () => String(version),
}));
</script>

<span>{version}</span>
