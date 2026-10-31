<script lang="ts">
import type { Snippet } from 'svelte';
import type { InboxEntry, IntakeReviewHost } from '../../review-dto.js';
import InboxView from './InboxView.svelte';
export interface Props {
  host: IntakeReviewHost;
  contextKey?: string;
  onselect?: (itemId: string) => void;
  /** Optional per-row aside (preview, original link); receives the page entry. */
  rowAside?: Snippet<[InboxEntry]>;
  /** File types the upload picker offers; defaults to the host's `uploadAccept`. */
  accept?: string;
}
let { host, contextKey = '', onselect, rowAside, accept }: Props = $props();
</script>
{#key host}{#key contextKey}<InboxView {host} {onselect} {rowAside} {accept} />{/key}{/key}
