<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import { ShellDockTool } from '@happyvertical/smrt-svelte/workspace';
import DockButtons from './DockButtons.svelte';
</script>

<!--
  The assistant icon at the bottom of the menu panel slides the dock in and out. Focus moves into
  the dock when it opens and back to the icon on Escape. The buttons in the
  page body drive the same dock from code with useShellDock().
-->
<AppShell
  title="Dock toggles"
  subtitle="AppShell playground"
  dockToggles={[
    { tool: 'assistant', label: 'Assistant', slot: 'leftSidebar.footer' },
    { tool: 'notes', label: 'Notes', icon: 'N' },
  ]}
>
  {#snippet dock()}
    <ShellDockTool id="assistant" label="Assistant" render={assistant} />
    <ShellDockTool id="notes" label="Notes" render={notes} />
  {/snippet}
  <main style="padding: 1rem">
    <h1>Dock toggles</h1>
    <DockButtons />
  </main>
</AppShell>

{#snippet assistant()}
  <label style="display: grid; gap: 0.5rem; padding: 1rem">
    Ask the assistant
    <input placeholder="Type here" />
  </label>
{/snippet}

{#snippet notes()}
  <p style="padding: 1rem">Notes tool</p>
{/snippet}
