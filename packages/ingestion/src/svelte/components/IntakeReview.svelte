<script lang="ts">
import type { IntakeReviewHost } from '../../review-dto.js';
import ReviewView from './ReviewView.svelte';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
  contextKey?: string;
  /** Reload interval while the host reports the item as processing. */
  pollMs?: number;
}
let { host, itemId, contextKey = '', pollMs = 2000 }: Props = $props();
</script>
{#key host}{#key contextKey}{#key itemId}<ReviewView {host} {itemId} {pollMs} />{/key}{/key}{/key}
