<script lang="ts">
import { useShellLayout } from '../../workspace/admin-shell/layout-context.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';

let { onApi }: { onApi: (api: ShellLayoutController) => void } = $props();
onApi(useShellLayout());
</script>
