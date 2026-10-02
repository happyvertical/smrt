<script lang="ts">
import { registerRuntimeDiagnosticsWebMcp } from './runtime-diagnostics-webmcp.js';

interface Props {
  /** Register the read-only diagnostics tool while true. */
  enabled?: boolean;
  /** Same-origin diagnostics endpoint. */
  endpoint?: string;
}

let { enabled = true, endpoint }: Props = $props();

$effect(() => {
  if (!enabled) return;
  const owner = registerRuntimeDiagnosticsWebMcp({ endpoint });
  return () => owner?.dispose();
});
</script>
