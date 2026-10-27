<script lang="ts">
import { untrack } from 'svelte';
import { useAdminShell } from '../../workspace/admin-shell/context.js';
import type { ShellState } from '../../workspace/admin-shell/state.svelte.js';

let { onShell }: { onShell: (shell: ShellState) => void } = $props();
untrack(() => onShell(useAdminShell()));
</script>
