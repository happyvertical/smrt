<script lang="ts">
import type { IntakeReviewHost } from '../../review-dto.js';
import ReviewView from './ReviewView.svelte';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
  contextKey?: string;
}
let { host, itemId, contextKey = '' }: Props = $props();
</script>
{#key host}{#key contextKey}{#key itemId}<ReviewView {host} {itemId} />{/key}{/key}{/key}
