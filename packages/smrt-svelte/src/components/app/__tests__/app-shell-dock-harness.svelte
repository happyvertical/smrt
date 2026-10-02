<script lang="ts">
import ShellDockTool from '../../workspace/admin-shell/ShellDockTool.svelte';
import AppShell from '../AppShell.svelte';
</script>

<AppShell>
  {#snippet dock()}
    <ShellDockTool id="assistant" label="Assistant" />
  {/snippet}
  <p>child</p>
</AppShell>
