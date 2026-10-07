<script lang="ts">
import type { ShellDock } from '../../workspace/admin-shell/dock.js';
import ShellDockTool from '../../workspace/admin-shell/ShellDockTool.svelte';
import AppShell from '../AppShell.svelte';
import type { DockToggle } from '../dock-toggle.js';
import DockProbe from './app-shell-dock-probe.svelte';

let {
  toggles = [{ tool: 'assistant', label: 'Assistant' }],
  onDock = () => {},
}: {
  toggles?: DockToggle[];
  onDock?: (dock: ShellDock) => void;
} = $props();
</script>

<AppShell dockToggles={toggles}>
  {#snippet dock()}
    <ShellDockTool id="assistant" label="Assistant" render={assistantBody} />
  {/snippet}
  <DockProbe {onDock} />
</AppShell>

{#snippet assistantBody()}
  <input data-testid="assistant-input" aria-label="Ask" />
{/snippet}
