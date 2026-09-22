<script lang="ts">
/**
 * AssistantDock width fixture (#3000).
 *
 * Mounts the real AssistantDock in fixed-width boxes that match a default
 * AdminShell right dock (250px), a portrait-tablet overlay (285px), and a
 * wide panel (800px). `e2e/assistant-dock-narrow.spec.ts` measures it.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import AssistantDock from '../../../svelte/components/assistant/AssistantDock.svelte';
import { createInMemoryAssistantTransport } from '../../../svelte/components/assistant/assistant-transport.js';

const docks = [250, 285, 800].map((width) => ({
  width,
  transport: createInMemoryAssistantTransport(),
  registry: createDataSurfaceRegistry(),
}));
</script>

<svelte:head>
  <title>AssistantDock width fixture</title>
</svelte:head>

<ThemeProvider colorScheme="light">
  {#each docks as dock (dock.width)}
    <div
      class="dock-box"
      data-width={dock.width}
      style:width="{dock.width}px"
      style:--smrt-font-family="Georgia, serif"
    >
      <AssistantDock transport={dock.transport} registry={dock.registry} />
    </div>
  {/each}
</ThemeProvider>

<style>
  .dock-box {
    height: 420px;
    margin: var(--smrt-spacing-2, 8px);
  }
</style>
