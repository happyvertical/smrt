<script lang="ts">
import { AppShell } from '@happyvertical/smrt-svelte/app';
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import BrowserAssistant from '../src/lib/components/BrowserAssistant.svelte';
import Page from '../src/routes/+page.svelte';
const registry = createDataSurfaceRegistry();
</script>
<AppShell title="Static Planner">
  <Page />
  <BrowserAssistant {registry} />
</AppShell>
