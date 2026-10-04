<script lang="ts">
import { useListSurface } from '../../../web/list-surface.svelte.js';
import { tryUseWebMcpUi } from '../../../web/webmcp-ui-context.js';

interface Props {
  onUi: (ui: unknown) => void;
}
let { onUi }: Props = $props();
onUi(tryUseWebMcpUi());

useListSurface(() => ({
  surfaceId: 'route-items',
  label: 'Route items',
  description: 'Items on this route',
  columns: [{ id: 'id', label: 'ID', rowKey: true }],
  rows: [{ id: '1' }],
}));
</script>

<p>route</p>
