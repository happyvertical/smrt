<script lang="ts">
import { useCommandPaletteProvider } from '../use-provider.svelte.js';

let { title = 'From child' }: { title?: string } = $props();

useCommandPaletteProvider(() => ({
  id: 'child',
  label: 'Child',
  items: () => [{ id: 'c', title, href: '/child' }],
}));
</script>
