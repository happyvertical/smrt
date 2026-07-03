<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAdminShell } from './context.js';
import type { ShellFocusTool } from './types.js';

interface Props extends ShellFocusTool {}

const shell = useAdminShell();
const props: Props = $props();
let unregister: (() => void) | null = null;

onMount(() => {
  unregister = shell.registerFocusTool(props);
});

onDestroy(() => {
  unregister?.();
});
</script>
