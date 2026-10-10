<script lang="ts">
import type { IntakeReviewHost } from '../../review-dto.js';
import InboxView from './InboxView.svelte';
export interface Props {
  host: IntakeReviewHost;
  contextKey?: string;
  onselect?: (itemId: string) => void;
}
let { host, contextKey = '', onselect }: Props = $props();
</script>
{#key host}{#key contextKey}<InboxView {host} {onselect} />{/key}{/key}
