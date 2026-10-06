<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { InventoryLocationData } from './types.js';
export interface Props {
  locations: InventoryLocationData[];
  onedit?: (location: InventoryLocationData) => void;
}
const { locations, onedit }: Props = $props();
</script>
<table>
  <caption>Inventory locations</caption>
  <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Status</th>{#if onedit}<th>Actions</th>{/if}</tr></thead>
  <tbody>{#each locations as location}
    <tr><td>{location.code}</td><td>{location.name}</td><td>{location.kind}</td><td>{location.active ? 'Active' : 'Inactive'}</td>{#if onedit}<td><Button onclick={() => onedit?.(location)}>Edit {location.code}</Button></td>{/if}</tr>
  {:else}<tr><td colspan={onedit ? 5 : 4}>No inventory locations</td></tr>{/each}</tbody>
</table>
