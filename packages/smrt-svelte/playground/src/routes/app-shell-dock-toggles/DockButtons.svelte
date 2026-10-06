<script lang="ts">
import { useShellDock } from '@happyvertical/smrt-svelte/workspace';

const dock = useShellDock();
</script>

<p>Open dock tool: {dock.active ?? 'none'}</p>
<button type="button" onclick={() => dock.open('assistant')}>Open assistant</button>
<button type="button" onclick={() => dock.toggle('notes')}>Toggle notes</button>
<button type="button" onclick={() => dock.close()}>Close dock</button>
