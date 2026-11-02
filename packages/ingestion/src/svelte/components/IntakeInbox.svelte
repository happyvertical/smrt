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
  /** Re-read the list on this interval (ms) while a listed row is still processing; off when absent. */
  listPollMs?: number;
}
let {
  host,
  contextKey = '',
  onselect,
  rowAside,
  accept,
  listPollMs,
}: Props = $props();
let inbox = $state<ReturnType<typeof InboxView>>();
/**
 * Re-read the list's first page, like its Refresh button; resolves `pending`
 * without reading while a read or operation is in flight.
 */
export function refresh(): Promise<{
  items: InboxEntry[];
  result: 'shown' | 'failed' | 'pending';
}> {
  return inbox
    ? inbox.refresh()
    : Promise.resolve({ items: [], result: 'pending' as const });
}
</script>
{#key host}{#key contextKey}<InboxView bind:this={inbox} {host} {onselect} {rowAside} {accept} {listPollMs} />{/key}{/key}
