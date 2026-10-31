<script lang="ts">
import type { Snippet } from 'svelte';
import type { InboxEntry, IntakeReviewHost } from '../../review-dto.js';
import TriageView from './TriageView.svelte';
export interface Props {
  host: IntakeReviewHost;
  /** Replace whenever the authenticated tenant/session context changes. */
  contextKey?: string;
  /** Item to open first; afterwards the workspace owns the selection. */
  itemId?: string;
  /** Reload interval while an item's background stage is in flight. */
  pollMs?: number;
  /** Told about every selection change (e.g. to keep a URL in step); never navigates. */
  onselect?: (itemId: string | undefined) => void;
  /** Optional per-row aside (preview, original link); receives the page entry. */
  rowAside?: Snippet<[InboxEntry]>;
  /** File types the upload picker offers; defaults to the host's `uploadAccept`. */
  accept?: string;
  /**
   * Re-read the list on this interval (ms) while a listed row is still
   * processing. Off when absent; processing rows are followed either way.
   */
  listPollMs?: number;
}
let {
  host,
  contextKey = '',
  itemId,
  pollMs = 2000,
  onselect,
  rowAside,
  accept,
  listPollMs,
}: Props = $props();
let triage = $state<ReturnType<typeof TriageView>>();
/**
 * Re-read the list's first page, like its Refresh button; resolves `pending`
 * without reading while a read or operation is in flight.
 */
export function refresh(): Promise<{
  items: InboxEntry[];
  result: 'shown' | 'failed' | 'pending';
}> {
  return triage
    ? triage.refresh()
    : Promise.resolve({ items: [], result: 'pending' as const });
}
</script>
{#key host}{#key contextKey}<TriageView bind:this={triage} {host} {itemId} {pollMs} {onselect} {rowAside} {accept} {listPollMs} />{/key}{/key}
