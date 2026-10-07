<script lang="ts">
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import { createInMemoryAssistantTransport } from '../../../svelte/components/assistant/assistant-transport.js';
import FloatingAssistant from '../../../svelte/components/assistant/FloatingAssistant.svelte';

const transport = createInMemoryAssistantTransport();
const registry = createDataSurfaceRegistry();
</script>

<svelte:head>
  <title>Floating assistant preview</title>
</svelte:head>

<ThemeProvider colorScheme="light">
  <main>
    <h1>Floating assistant</h1>
    <p>
      This mock transport uses the same permanently mounted dock as production;
      collapse and reopen it while keeping the conversation state alive.
    </p>
  </main>
  <FloatingAssistant {transport} {registry} contextMode="server" />
</ThemeProvider>

<style>
  main {
    max-inline-size: 42rem;
    margin: 3rem auto;
    padding: 1rem;
    font-family: var(--smrt-font-family, system-ui, sans-serif);
  }
</style>
