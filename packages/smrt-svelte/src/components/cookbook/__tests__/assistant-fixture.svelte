<script lang="ts">
import type { AssistantTransport } from '@happyvertical/smrt-chat/svelte';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';

let {
  transport,
  registry,
  visible,
  contextMode,
}: {
  transport: AssistantTransport;
  registry: DataSurfaceRegistry;
  visible?: boolean;
  contextMode?: string;
  messageFormat?: string;
} = $props();
</script>
<p data-testid="assistant-dock" data-visible={visible} data-context={contextMode} data-registry={!!registry} data-transport={!!transport}>Docked conversation</p>
