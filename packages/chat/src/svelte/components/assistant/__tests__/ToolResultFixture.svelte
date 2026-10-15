<script lang="ts">
import type { AssistantMessage } from '../assistant-transport.js';
export interface Props {
  message: AssistantMessage;
}
let { message }: Props = $props();
</script>
<p data-testid="tool-result-component">Result for {message.id}</p>
