<script lang="ts">
import AppShell from '../AppShell.svelte';
import Probe from './app-shell-webmcp-probe.svelte';

interface Props {
  webmcp: boolean | Record<string, unknown>;
  onUi: (ui: unknown) => void;
}
let { webmcp, onUi }: Props = $props();
</script>

<AppShell webmcp={webmcp as never}>
  <Probe {onUi} />
</AppShell>
