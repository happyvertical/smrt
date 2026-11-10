<script lang="ts">
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { createI18nContext, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import AssistantDock from '../AssistantDock.svelte';
import type { AssistantTransport } from '../assistant-transport.js';

const {
  transport,
  registry,
}: {
  transport: AssistantTransport;
  registry: DataSurfaceRegistry;
} = $props();
setI18nContext(
  createI18nContext({
    locale: 'fr',
    messages: {
      'chat.assistant_dock.conversation_starters': 'Débuts de conversation',
    },
  }),
);
</script>
<AssistantDock {transport} {registry} contextMode="server" conversations="single" suggestions={[{ label: 'Report', prompt: 'Count invoices' }]} />
