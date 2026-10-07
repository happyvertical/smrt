<script lang="ts">
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import ShellLayoutEditor from '../../workspace/admin-shell/ShellLayoutEditor.svelte';
import type { ShellPanelDefaults } from '../../workspace/admin-shell/types.js';
import AppShell from '../AppShell.svelte';
import type { DockToggle } from '../dock-toggle.js';
import Probe from './shell-layout-probe.svelte';

let {
  initial,
  toggles = [{ tool: 'assistant', label: 'Assistant' }],
  config,
  withHostSlot = true,
  onChange,
  onApi,
}: {
  initial?: ShellLayout | null;
  toggles?: DockToggle[];
  config?: ShellPanelDefaults;
  withHostSlot?: boolean;
  onChange?: (layout: ShellLayout) => void;
  onApi?: (api: ShellLayoutController) => void;
} = $props();

let current = $state<ShellLayout | null>(initial ?? null);
function change(next: ShellLayout) {
  current = next;
  onChange?.(next);
}
</script>

{#snippet legacy()}<span data-testid="legacy">Legacy</span>{/snippet}
{#snippet clock()}<span data-testid="clock">12:00</span>{/snippet}

<AppShell
  dockToggles={toggles}
  slots={withHostSlot ? { 'footer.center': legacy } : undefined}
  slotItems={[{ id: 'host:clock', label: 'Clock', slot: 'header.start', render: clock }]}
  {config}
  layout={current}
  onlayoutchange={change}
>
  {#if onApi}<Probe {onApi} />{/if}
  <ShellLayoutEditor />
</AppShell>
