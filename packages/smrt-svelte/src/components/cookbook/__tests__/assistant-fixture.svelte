<script lang="ts">
import type { AssistantTransport } from '@happyvertical/smrt-chat/svelte';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';

let {
  transport,
  registry,
  visible,
  contextMode,
  toolPresentation,
}: {
  transport: AssistantTransport;
  registry: DataSurfaceRegistry;
  visible?: boolean;
  contextMode?: string;
  messageFormat?: string;
  toolPresentation?: 'generic';
} = $props();
</script>
<p data-testid="assistant-dock" data-visible={visible} data-context={contextMode} data-tool-presentation={toolPresentation} data-registry={!!registry} data-transport={!!transport}>Docked conversation</p>
