<script lang="ts">
import '@happyvertical/smrt-ui/themes/styles/fonts.css';
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import { playgroundModules } from 'virtual:smrt-playground/modules';
</script>

<PlaygroundHost
  title="SMRT Package Playground"
  subtitle="Workspace packages publish their own previews; this host simply discovers and renders them."
  modules={playgroundModules}
/>
