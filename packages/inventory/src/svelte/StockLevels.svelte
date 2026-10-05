<script lang="ts">
import type { StockLevelData } from './types.js';
export interface Props {
  levels: StockLevelData[];
  locationId?: string;
}
const { levels, locationId }: Props = $props();
const visible = $derived(
  levels.filter(
    (level) => locationId === undefined || level.locationId === locationId,
  ),
);
</script>
<table>
  <caption>Stock levels by location</caption>
  <thead><tr><th>Location</th><th>SKU</th><th>State</th><th>Quantity</th><th>Reorder point</th><th>Reorder quantity</th><th>Status</th></tr></thead>
  <tbody>
    {#each visible as level}
      <tr><td>{level.locationId}</td><td>{level.skuId}</td><td>{level.state}</td><td>{level.qty}</td><td>{level.reorderPoint ?? '—'}</td><td>{level.reorderQuantity ?? '—'}</td><td>{level.state === 'available' && level.reorderPoint != null && level.qty < level.reorderPoint ? 'Low stock' : '—'}</td></tr>
    {:else}<tr><td colspan="7">No stock levels</td></tr>{/each}
  </tbody>
</table>
