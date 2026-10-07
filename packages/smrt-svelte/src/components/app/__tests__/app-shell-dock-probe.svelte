<script lang="ts">
import {
  type ShellDock,
  useShellDock,
} from '../../workspace/admin-shell/dock.js';

let { onDock }: { onDock: (dock: ShellDock) => void } = $props();
const dock = useShellDock();
onDock(dock);
</script>

<button type="button" data-testid="outside">outside</button>
