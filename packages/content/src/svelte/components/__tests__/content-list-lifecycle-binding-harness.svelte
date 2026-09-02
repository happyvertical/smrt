<script lang="ts">
import type { ContentListLifecycleBinding } from '../../content-list-lifecycle.js';
import ContentListLifecyclePanel from '../ContentListLifecyclePanel.svelte';

interface Props {
  binding: ContentListLifecycleBinding;
  onReady: (setBinding: (next: ContentListLifecycleBinding) => void) => void;
}

const props: Props = $props();
// svelte-ignore state_referenced_locally
let currentBinding = $state(props.binding);
// svelte-ignore state_referenced_locally
props.onReady((next) => {
  currentBinding = next;
});
</script>

<ContentListLifecyclePanel
  binding={currentBinding}
  mode="active"
  selectedRowIds={['article-1']}
  viewKey="active-query"
  oncomplete={() => undefined}
/>
