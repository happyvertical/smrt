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
}
let {
  host,
  contextKey = '',
  itemId,
  pollMs = 2000,
  onselect,
  rowAside,
}: Props = $props();
</script>
{#key host}{#key contextKey}<TriageView {host} {itemId} {pollMs} {onselect} {rowAside} />{/key}{/key}
