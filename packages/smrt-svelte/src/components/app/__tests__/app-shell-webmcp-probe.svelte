<script lang="ts">
import { tryUseWebMcpUi } from '../../../web/webmcp-ui-context.js';

interface Props {
  onUi: (ui: unknown) => void;
}
let { onUi }: Props = $props();
const ui = tryUseWebMcpUi();
$effect(() => onUi(ui));
</script>

<p>probe</p>
