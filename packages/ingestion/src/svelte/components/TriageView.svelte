<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, type Snippet, tick, untrack } from 'svelte';
import type {
  InboxEntry,
  IntakeReviewHost,
  ItemReviewView,
} from '../../review-dto.js';
import { M } from '../i18n.js';
import {
  entryStatus,
  reviewInFlight,
  type TriageStatus,
  triageSettled,
  triageTerminal,
  viewStatus,
} from '../view-utils.js';
import type { ReviewOutcome } from './ActionReview.svelte';
import InboxView from './InboxView.svelte';
import ReviewView from './ReviewView.svelte';
export interface Props {
  host: IntakeReviewHost;
  /** Item to open first; afterwards the workspace owns the selection. */
  itemId?: string;
  /** Reload interval while an item's background stage is in flight. */
  pollMs?: number;
  /** Told about every selection change, e.g. to keep a URL in step; never navigates. */
  onselect?: (itemId: string | undefined) => void;
  rowAside?: Snippet<[InboxEntry]>;
}
let { host, itemId, pollMs = 2000, onselect, rowAside }: Props = $props();
const { t } = useI18n();
/** Items left mid-reinterpretation whose rows keep following their stage. */
const WATCH_LIMIT = 5;
/** Consecutive thrown watch reads tolerated before a row stops following. */
const MAX_WATCH_FAILURES = 3;
let selected = $state<string | undefined>(untrack(() => itemId)),
  rows = $state.raw<InboxEntry[]>([]),
  more = $state(false),
  done = $state(false),
  announcement = $state(''),
  // Richer status from a loaded view, valid while the row still shows the
  // same entry (revision, state, processing, disposition) it came from.
  statuses = $state<Record<string, { key: string; status: TriageStatus }>>({});
let inbox = $state<ReturnType<typeof InboxView>>();
let pane = $state<HTMLElement>();
let root = $state<HTMLElement>();
let alive = true,
  // The selected item's latest available view, as its pane displayed it.
  paneView: ItemReviewView | undefined,
  // The pane is between clearing a displayed view and showing the next one.
  paneBusy = false,
  watched: string[] = [],
  watchTimer: ReturnType<typeof setTimeout> | undefined,
  watchTicks = 0;
const failures = new Map<string, number>();
// Followed items seen with a stage in flight; only those announce settling.
const staged = new Set<string>();
onDestroy(() => {
  alive = false;
  clearTimeout(watchTimer);
  watched = [];
});
const position = $derived(
  selected ? rows.findIndex((row) => row.item.id === selected) : -1,
);
const label = $derived(position >= 0 ? rows[position].label : undefined);
function fingerprint(entry: InboxEntry) {
  return [
    entry.item.analysisRevision,
    entry.state,
    entry.item.processingState,
    entry.item.disposition?.at ?? '',
  ].join(':');
}
function statusOf(entry: InboxEntry): TriageStatus {
  const cached = statuses[entry.item.id];
  return cached && cached.key === fingerprint(entry)
    ? cached.status
    : entryStatus(entry);
}
function statusText(status: TriageStatus) {
  const base =
    status.kind === 'state'
      ? t(M[`ingestion.${status.state}`])
      : status.kind === 'resolved'
        ? t(M['ingestion.resolved'])
        : t(M[`ingestion.triage.${status.kind}`]);
  const reason =
    status.kind === 'needs_review' && status.missing?.length
      ? t(M['ingestion.triage.missing'], { fields: status.missing.join(', ') })
      : 'reason' in status
        ? status.reason
        : undefined;
  return reason
    ? t(M['ingestion.statusReason'], { status: base, reason })
    : base;
}
const rowStatus = (entry: InboxEntry) => statusText(statusOf(entry));
/** Follow a displayed view: cache its status and patch its row in place. */
function record(view: ItemReviewView, keep: boolean) {
  const id = view.entry.item.id;
  if (view.availability !== 'available') {
    delete statuses[id];
    return;
  }
  statuses[id] = { key: fingerprint(view.entry), status: viewStatus(view) };
  if (inbox) rows = inbox.patch(view.entry, keep);
}
function listed(items: InboxEntry[], hasMore: boolean) {
  rows = items;
  more = hasMore;
}
function paneChanged(view: ItemReviewView | undefined) {
  if (!view) {
    // The pane cleared its view for a reload or an operation (an instruction,
    // say) whose result it has not shown yet.
    paneBusy = true;
    return;
  }
  if (view.entry.item.id !== selected) return;
  paneBusy = false;
  const snapshot = $state.snapshot(view) as ItemReviewView;
  paneView = snapshot.availability === 'available' ? snapshot : undefined;
  // The open item stays listed while the reviewer works on it, even if its
  // state no longer matches the filter; it leaves when they move on.
  record(snapshot, true);
}
function schedule() {
  clearTimeout(watchTimer);
  if (!alive || !watched.length) {
    watchTicks = 0;
    return;
  }
  const delay = Math.min(pollMs * 1.5 ** watchTicks, pollMs * 5);
  watchTicks++;
  watchTimer = setTimeout(() => void follow(), delay);
}
function watch(id: string) {
  const next = [...watched.filter((entry) => entry !== id), id];
  // Beyond the bound the oldest row stops following; its listed state remains.
  for (const dropped of next.slice(0, -WATCH_LIMIT)) {
    failures.delete(dropped);
    staged.delete(dropped);
  }
  watched = next.slice(-WATCH_LIMIT);
  watchTicks = 0;
  schedule();
}
function unwatch(id: string) {
  watched = watched.filter((entry) => entry !== id);
  failures.delete(id);
  staged.delete(id);
}
/**
 * One watch tick: re-read each followed item through the same authenticated
 * `load` the item pane uses (first review page only), one after another.
 * Bounded by WATCH_LIMIT items per tick with the pane's backoff; a row stops
 * following once its stage settles, its host view is denied, or three reads
 * in a row throw.
 */
async function follow() {
  for (const id of [...watched]) {
    if (!alive) return;
    if (!watched.includes(id)) continue;
    try {
      const view = await host.load(id);
      if (!alive) return;
      if (!watched.includes(id)) continue;
      failures.delete(id);
      if (view.availability !== 'available') {
        unwatch(id);
        delete statuses[id];
        continue;
      }
      const settled = !reviewInFlight(view);
      if (!settled) staged.add(id);
      const finished = settled && staged.has(id);
      if (settled) unwatch(id);
      record(view, false);
      // Announce only a background stage that was seen running and has now
      // settled, under the row's listed label.
      if (finished)
        announcement = t(M['ingestion.backgroundUpdate'], {
          label:
            rows.find((row) => row.item.id === id)?.label ?? view.entry.label,
          status: statusText(viewStatus(view)),
        });
    } catch {
      if (!alive) return;
      const count = (failures.get(id) ?? 0) + 1;
      failures.set(id, count);
      if (count >= MAX_WATCH_FAILURES) {
        unwatch(id);
        delete statuses[id];
      }
    }
  }
  schedule();
}
/** Open an item in the pane; the previous one keeps following its stage if in flight. */
async function choose(id: string | undefined, focus: boolean) {
  if (id !== selected) {
    const previous = paneView;
    const left = selected;
    // An item left mid-stage, or before the pane showed the result of its
    // latest operation (an instruction just recorded), keeps following.
    if (left && (paneBusy || reviewInFlight(previous))) {
      if (reviewInFlight(previous)) staged.add(left);
      watch(left);
    }
    paneView = undefined;
    paneBusy = false;
    // Leaving the item applies the listed filter to its row.
    if (previous && previous.entry.item.id === left && inbox)
      rows = inbox.patch(previous.entry);
    selected = id;
    if (id) unwatch(id);
    onselect?.(id);
  }
  done = !id;
  if (focus) {
    await tick();
    pane?.focus();
  }
}
async function move(offset: 1 | -1) {
  let list = rows;
  const index = list.findIndex((row) => row.item.id === selected);
  let target =
    index < 0 ? (offset > 0 ? list[0] : list.at(-1)) : list[index + offset];
  if (!target && offset > 0 && more && inbox) {
    list = await inbox.more();
    target = list[(index < 0 ? -1 : index) + 1];
  }
  if (target) await choose(target.item.id, true);
}
/** After an item is finished: drop it under the filter and open the next open item. */
async function advance() {
  const current = selected;
  const before = rows.findIndex((row) => row.item.id === current);
  let list = paneView && inbox ? inbox.patch(paneView.entry) : rows;
  const start =
    before < 0 ? 0 : list[before]?.item.id === current ? before + 1 : before;
  const open = (row: InboxEntry) =>
    row.item.id !== current && !triageTerminal(statusOf(row));
  let next = list.slice(start).find(open);
  while (!next && more && inbox) {
    const count = list.length;
    list = await inbox.more();
    // No progress (for example a denied page) must not spin on a host callback.
    if (!alive || selected !== current) return;
    next = list.slice(start).find(open);
    if (list.length <= count) break;
  }
  next ??= list.slice(0, start).find(open);
  await choose(next?.item.id, true);
}
function outcome(_kind: ReviewOutcome, view: ItemReviewView) {
  if (view.entry.item.id !== selected) return;
  paneChanged(view);
  if (triageSettled(view)) void advance();
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (target instanceof Element) {
    if (target !== document.body && !root?.contains(target)) return;
    if (
      target.closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
      )
    )
      return;
  }
  const key = event.key;
  const plain = !event.altKey && !event.shiftKey;
  const offset =
    (plain && (key === 'j' || key === 'J')) ||
    (event.altKey && key === 'ArrowDown')
      ? 1
      : (plain && (key === 'k' || key === 'K')) ||
          (event.altKey && key === 'ArrowUp')
        ? -1
        : 0;
  if (!offset) return;
  event.preventDefault();
  void move(offset);
}
</script>
<svelte:window onkeydown={keydown} />
<div class="workspace" bind:this={root} data-testid="intake-workspace">
<div class="list-pane">
<InboxView bind:this={inbox} {host} {rowAside} selectedId={selected} onselect={(id) => choose(id, true)} onitems={listed} status={rowStatus} resolveInRow={false} />
</div>
<section class="item-pane" bind:this={pane} tabindex="-1" aria-label={label ?? t(M['ingestion.selectedItem'])} data-testid="workspace-item">
<div class="queue-nav" role="group" aria-label={t(M['ingestion.workspace'])}>
<Button disabled={position === 0 || !rows.length} aria-keyshortcuts="K Alt+ArrowUp" onclick={() => move(-1)}>{t(M['ingestion.previousItem'])}</Button>
{#if position >= 0}<p data-testid="queue-position">{t(M['ingestion.itemOf'], { index: position + 1, count: rows.length })}</p>{/if}
<Button disabled={(position >= rows.length - 1 && !more) || !rows.length} aria-keyshortcuts="J Alt+ArrowDown" onclick={() => move(1)}>{t(M['ingestion.nextItem'])}</Button>
</div>
<p class="hint">{t(M['ingestion.keyboardHelp'])}</p>
<p role="status" data-testid="background-update">{announcement}</p>
{#if selected}
{#key selected}<ReviewView {host} itemId={selected} {pollMs} layout="stacked" onview={paneChanged} onoutcome={outcome} />{/key}
{:else if done}<p role="status" data-testid="queue-done">{t(M['ingestion.queueDone'])}</p>
{:else}<p>{t(M['ingestion.selectItem'])}</p>{/if}
</section>
</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
.workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;color:var(--smrt-color-on-surface)}.list-pane,.item-pane{min-width:0}.item-pane{outline-offset:.25rem}.queue-nav{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding-inline:1rem}.queue-nav p,.hint{margin:0}.hint{padding-inline:1rem;font-size:.875rem}[data-testid='background-update']{padding-inline:1rem;margin:0}@media(min-width:64rem){.workspace{grid-template-columns:minmax(18rem,26rem) minmax(0,1fr)}.list-pane{position:sticky;inset-block-start:0;align-self:start;max-block-size:100vh;overflow:auto}}
}
</style>
