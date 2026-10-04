<script lang="ts">
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import ShellDockTool from '../../workspace/admin-shell/ShellDockTool.svelte';
import AppShell from '../AppShell.svelte';
import Route from './app-shell-dock-route.svelte';

let {
  onRegistry,
  webmcp = false,
  onUi = () => {},
}: {
  onRegistry?: (registry: DataSurfaceRegistry) => void;
  webmcp?: boolean;
  onUi?: (ui: unknown) => void;
} = $props();
</script>

<AppShell {webmcp}>
  {#snippet dock(registry)}
    {@const _ = onRegistry?.(registry)}
    <ShellDockTool id="assistant" label="Assistant" />
  {/snippet}
  <Route {onUi} />
</AppShell>
