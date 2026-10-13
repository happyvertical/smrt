<script lang="ts">
import AppShell from '../AppShell.svelte';

let { chrome = true }: { chrome?: boolean } = $props();
</script>

<AppShell {chrome}>
  <p>page body</p>
</AppShell>
