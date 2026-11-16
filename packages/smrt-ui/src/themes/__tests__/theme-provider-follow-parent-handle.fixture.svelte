<script lang="ts">
import { getThemeContext } from '../context.svelte.js';

let { onhost }: { onhost?: (c: ReturnType<typeof getThemeContext>) => void } =
  $props();
onhost?.(getThemeContext());
</script>
