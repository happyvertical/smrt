<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import Planner from '../src/lib/planner/Planner.svelte';

let { hosted }: { hosted: boolean } = $props();
</script>

{#if hosted}
  <ThemeProvider colorScheme="light">
    <Planner persistence="host" />
  </ThemeProvider>
{:else}
  <Planner persistence="host" />
{/if}
