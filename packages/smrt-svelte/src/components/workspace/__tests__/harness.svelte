<script lang="ts">
/**
 * Test harness — invokes defineToolsDock() inside a component init scope so
 * setContext() is legal, then passes the returned instance back to the
 * test via the `onReady` callback prop.
 */
import {
  type DefineToolsDockOptions,
  defineToolsDock,
  type ToolsDockInstance,
} from '../tools-dock/define-tools-dock.svelte.js';

interface Props {
  options: DefineToolsDockOptions;
  onReady: (dock: ToolsDockInstance) => void;
}

const props: Props = $props();
const dock = defineToolsDock(props.options);
props.onReady(dock);
</script>
