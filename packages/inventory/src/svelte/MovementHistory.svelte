<script lang="ts">
import type { StockMovementData } from './types.js';
export interface Props {
  movements: StockMovementData[];
}
const { movements }: Props = $props();
</script>
<table>
  <caption>Stock movement history</caption>
  <thead><tr><th>When</th><th>Location</th><th>SKU</th><th>Quantity</th><th>Reason</th><th>Actor</th><th>Source</th><th>Note</th></tr></thead>
  <tbody>{#each movements as movement}
    <tr><td>{movement.occurredAt instanceof Date ? movement.occurredAt.toISOString() : movement.occurredAt ?? '—'}</td><td>{movement.locationId}</td><td>{movement.skuId}</td><td>{movement.qty}</td><td>{movement.reasonCode}</td><td>{movement.actorProfileId ?? 'Unattributed'}</td><td>{movement.sourceType} {movement.sourceId}</td><td>{movement.note}</td></tr>
  {:else}<tr><td colspan="8">No stock movements</td></tr>{/each}</tbody>
</table>
