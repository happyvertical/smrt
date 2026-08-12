<script lang="ts">
import '@happyvertical/smrt-ui/themes/styles/fonts.css';
import { WorkbenchHost } from '@happyvertical/smrt-workbench/svelte';
import {
  playgroundModules,
  workbenchModules,
  workbenchProject,
} from 'virtual:smrt-workbench/project';
</script>

<WorkbenchHost
  project={workbenchProject}
  modules={workbenchModules}
  {playgroundModules}
/>
