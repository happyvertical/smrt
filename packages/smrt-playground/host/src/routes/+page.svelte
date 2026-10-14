<script lang="ts">
import '@happyvertical/smrt-ui/themes/styles/all.css';
import '@happyvertical/smrt-ui/themes/styles/fonts.css';
import '@happyvertical/smrt-ui/themes/styles/base.css';
import '@happyvertical/smrt-ui/themes/styles/happyvertical-fonts.css';
import { page } from '$app/state';
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import { playgroundModules } from 'virtual:smrt-playground/modules';
</script>

<PlaygroundHost
  title="SMRT Package Playground"
  subtitle="Workspace packages publish their own previews; this host simply discovers and renders them."
  modules={playgroundModules}
  selectedEntryId={page.url.searchParams.get('entry')}
/>
