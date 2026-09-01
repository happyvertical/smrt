<script lang="ts">
  import { registerRuntimeDiagnosticsWebMcp } from './runtime-diagnostics-webmcp.js';

  let { enabled = true }: { enabled?: boolean } = $props();

  $effect(() => {
    if (!enabled) return;
    const owner = registerRuntimeDiagnosticsWebMcp();
    return () => owner?.dispose();
  });
</script>
