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
/**
 * Most followed items read per watch tick. Followed items are read in
 * rotation, so every followed row is reached; an item stops being followed
 * when it settles, is denied, fails three reads in a row, leaves the
 * displayed list, or is the longest-followed item beyond WATCH_CAP.
 */
const WATCH_LIMIT = 5;
/**
 * Most items followed at once. Beyond it the longest-followed item stops
 * following and its row returns to the entry its page listed.
 */
const WATCH_CAP = 20;
/** Most page appends one automatic advance makes while looking for an open row. */
const ADVANCE_PAGES = 5;
/** Consecutive thrown watch reads tolerated before a row stops following. */
const MAX_WATCH_FAILURES = 3;
let selected = $state<string | undefined>(untrack(() => itemId)),
  rows = $state.raw<InboxEntry[]>([]),
  more = $state(false),
  done = $state(false),
  announcement = $state(''),
  // A selection the reviewer asked for while the pane held unsent input, and
  // the control they were in, which "Stay" returns to.
  leaving = $state<{ id: string; from?: HTMLElement }>(),
  // The open item finished but did not advance: `unsent` input remains on
  // it, the next open item was not reached (`retry`: Next still works), or
  // a page append failed and the list failed closed (`failed`).
  held = $state<'unsent' | 'retry' | 'failed'>(),
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
  // The pane holds reviewer input that has not been sent.
  paneDirty = false,
  // Bumped on every selection change; a navigation that awaited a page
  // append gives up if the reviewer chose something meanwhile.
  navigation = 0,
  // Followed items in read-rotation order, and in the order they started.
  watched: string[] = [],
  started: string[] = [],
  watchTimer: ReturnType<typeof setTimeout> | undefined,
  watchTicks = 0,
  // Only one watch tick runs at a time.
  following = false;
let stay = $state<HTMLElement>();
// The last form field the reviewer used in the item pane.
let lastField: HTMLElement | undefined;
function noteField(event: FocusEvent) {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.matches('input,textarea,select,[contenteditable]')
  )
    lastField = target;
}
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
    fallback(id);
    return;
  }
  statuses[id] = { key: fingerprint(view.entry), status: viewStatus(view) };
  if (inbox) rows = inbox.patch(view.entry, keep);
  // A followed row the filter removed is no longer followed.
  if (!displayed(id)) unwatch(id);
}
const displayed = (id: string) => rows.some((row) => row.item.id === id);
// Each row's entry exactly as a page read returned it (never a patched
// entry): the state a row falls back to.
let listedEntries = new Map<string, InboxEntry>();
// The latest entry a follow read saw, per followed or just-settled item,
// re-applied over a page that may have been read before it.
let followedEntries = new Map<string, InboxEntry>();
/**
 * Forget what loaded views said about a row (a denial, a failed follow, the
 * follow cap): drop its cached status and restore the entry its page listed.
 */
function fallback(id: string) {
  delete statuses[id];
  followedEntries.delete(id);
  const entry = listedEntries.get(id);
  if (entry && inbox) rows = inbox.patch(entry, true);
}
function listed(
  items: InboxEntry[],
  hasMore: boolean,
  page?: { entries: InboxEntry[]; appended: boolean },
) {
  if (page) {
    if (!page.appended) listedEntries = new Map();
    for (const entry of page.entries) listedEntries.set(entry.item.id, entry);
  }
  rows = items;
  more = hasMore;
  if (!page || !inbox) return;
  // A page read before the pane's latest view, or before a followed item's
  // latest read, must not regress those rows.
  const open = paneView;
  if (open && displayed(open.entry.item.id))
    rows = inbox.patch(open.entry, true);
  for (const [id, entry] of followedEntries) {
    if (displayed(id) && id !== open?.entry.item.id) rows = inbox.patch(entry);
    // A settled item needed this one re-application only.
    if (!watched.includes(id)) followedEntries.delete(id);
  }
  // Rows no longer displayed are not followed.
  for (const id of watched) if (!displayed(id)) unwatch(id);
}
function paneChanged(view: ItemReviewView | undefined, denied = false) {
  if (!view) {
    if (denied) {
      // A failed callback cleared the pane: it fails closed, so nothing it
      // showed (status reasons included) stays on the row or is followed.
      paneView = undefined;
      paneBusy = false;
      if (selected) fallback(selected);
      return;
    }
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
  watchTimer = undefined;
  if (!alive || !watched.length) {
    watchTicks = 0;
    return;
  }
  const delay = Math.min(pollMs * 1.5 ** watchTicks, pollMs * 5);
  watchTicks++;
  watchTimer = setTimeout(() => {
    watchTimer = undefined;
    void follow();
  }, delay);
}
function watch(id: string) {
  if (!displayed(id) || watched.includes(id)) return;
  watched = [...watched, id];
  started = [...started, id];
  // Beyond the cap the longest-followed item (the earliest started, whatever
  // the read rotation) stops and falls back.
  while (started.length > WATCH_CAP) {
    const dropped = started[0];
    unwatch(dropped);
    fallback(dropped);
  }
  // The backoff carries on; only an idle follower starts a tick (a running
  // tick, or one already scheduled, picks the new item up).
  if (!following && watchTimer === undefined) schedule();
}
function unwatch(id: string) {
  watched = watched.filter((entry) => entry !== id);
  started = started.filter((entry) => entry !== id);
  failures.delete(id);
  staged.delete(id);
}
/**
 * One watch tick: re-read up to WATCH_LIMIT followed items through the same
 * authenticated `load` the item pane uses (first review page only), one
 * after another, least recently read first, on the pane's backoff. A row
 * stops following once its stage settles, its host view is denied, three
 * reads in a row throw, or it leaves the list.
 */
async function follow() {
  if (following || !alive) return;
  following = true;
  try {
    await followBatch();
  } finally {
    following = false;
  }
  schedule();
}
async function followBatch() {
  const batch = watched.slice(0, WATCH_LIMIT);
  // Rotate: the rest are read first next tick.
  watched = [...watched.slice(WATCH_LIMIT), ...batch];
  for (const id of batch) {
    if (!alive) return;
    if (!watched.includes(id)) continue;
    try {
      const view = await host.load(id);
      if (!alive) return;
      if (!watched.includes(id)) continue;
      failures.delete(id);
      if (view.availability !== 'available') {
        unwatch(id);
        fallback(id);
        continue;
      }
      const settled = !reviewInFlight(view);
      if (!settled) staged.add(id);
      const finished = settled && staged.has(id);
      if (settled) unwatch(id);
      followedEntries.set(id, view.entry);
      record(view, false);
      // Announce only a background stage that was seen running and has now
      // settled, on a row still displayed, under its listed label.
      if (finished && displayed(id))
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
        fallback(id);
      }
    }
  }
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
    if (previous && previous.entry.item.id === left && inbox) {
      rows = inbox.patch(previous.entry);
      if (watched.includes(left)) followedEntries.set(left, previous.entry);
    }
    if (left && !displayed(left)) unwatch(left);
    selected = id;
    navigation++;
    paneDirty = false;
    leaving = undefined;
    held = undefined;
    if (id) unwatch(id);
    onselect?.(id);
  }
  done = !id;
  if (focus) {
    await tick();
    pane?.focus();
  }
}
/**
 * A selection the reviewer asked for (row, keyboard, buttons). Unsent input
 * in the pane would be lost with it, so that asks first, inline.
 */
async function request(id: string) {
  if (id === selected) return;
  if (paneDirty) {
    const from = lastField?.isConnected ? lastField : undefined;
    leaving = { id, ...(from ? { from } : {}) };
    await tick();
    stay
      ?.querySelector<HTMLElement>('[data-stay] button, button[data-stay]')
      ?.focus();
    return;
  }
  await choose(id, true);
}
async function discardAndLeave() {
  const target = leaving?.id;
  leaving = undefined;
  if (target) await choose(target, true);
}
async function keepEditing() {
  const from = leaving?.from;
  leaving = undefined;
  await tick();
  // Back to the control the reviewer was in, when it is still there.
  if (from?.isConnected) from.focus();
  else pane?.focus();
}
async function move(offset: 1 | -1) {
  const ticket = navigation;
  let list = rows;
  const index = list.findIndex((row) => row.item.id === selected);
  let target =
    index < 0 ? (offset > 0 ? list[0] : list.at(-1)) : list[index + offset];
  if (!target && offset > 0 && more && inbox) {
    const page = await inbox.more();
    // The reviewer chose something else while the page loaded.
    if (ticket !== navigation) return;
    target = page.items[(index < 0 ? -1 : index) + 1];
  }
  if (target) await request(target.item.id);
}
/** After an item is finished: drop it under the filter and open the next open item. */
async function advance() {
  const ticket = navigation;
  const current = selected;
  const before = rows.findIndex((row) => row.item.id === current);
  let list = paneView && inbox ? inbox.patch(paneView.entry) : rows;
  rows = list;
  const start =
    before < 0 ? 0 : list[before]?.item.id === current ? before + 1 : before;
  const open = (row: InboxEntry) =>
    row.item.id !== current && !triageTerminal(statusOf(row));
  let next = list.slice(start).find(open);
  let unknown: 'retry' | 'failed' | undefined;
  // Pages of finished rows are skipped, up to ADVANCE_PAGES appends; past
  // that bound, or when an append fails or cannot start, whether anything
  // follows is unknown and the queue is never reported empty.
  for (let pages = 0; !next && more && inbox; pages++) {
    if (pages === ADVANCE_PAGES) {
      unknown = 'retry';
      break;
    }
    const page = await inbox.more();
    if (ticket !== navigation) return;
    // Input typed while the page loaded is not discarded either.
    if (paneDirty) {
      held = 'unsent';
      return;
    }
    list = page.items;
    if (page.result === 'failed' || page.result === 'pending') {
      // A failed append failed the list closed (no rows, no Next); a
      // pending one leaves Next working.
      unknown = page.result === 'failed' ? 'failed' : 'retry';
      break;
    }
    next = list.slice(start).find(open);
  }
  next ??= list.slice(0, start).find(open);
  if (!next && unknown) {
    held = unknown;
    return;
  }
  await choose(next?.item.id, true);
}
function outcome(_kind: ReviewOutcome, view: ItemReviewView) {
  if (view.entry.item.id !== selected) return;
  paneChanged(view);
  if (!triageSettled(view)) return;
  // Unsent input on the same item is never discarded by an automatic
  // move: the reviewer moves on explicitly (through the confirmation).
  if (paneDirty) {
    held = 'unsent';
    return;
  }
  void advance();
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
<InboxView bind:this={inbox} {host} {rowAside} selectedId={selected} onselect={(id) => request(id)} onitems={listed} status={rowStatus} resolveInRow={false} />
</div>
<section class="item-pane" bind:this={pane} tabindex="-1" aria-label={label ?? t(M['ingestion.selectedItem'])} data-testid="workspace-item" onfocusin={noteField}>
<div class="queue-nav" role="group" aria-label={t(M['ingestion.workspace'])}>
<Button disabled={position === 0 || !rows.length} aria-keyshortcuts="K Alt+ArrowUp" onclick={() => move(-1)}>{t(M['ingestion.previousItem'])}</Button>
{#if position >= 0}<p data-testid="queue-position">{t(M['ingestion.itemOf'], { index: position + 1, count: rows.length })}</p>{/if}
<Button disabled={(position >= rows.length - 1 && !more) || !rows.length} aria-keyshortcuts="J Alt+ArrowDown" onclick={() => move(1)}>{t(M['ingestion.nextItem'])}</Button>
</div>
<p class="hint">{t(M['ingestion.keyboardHelp'])}</p>
<p role="status" data-testid="background-update">{announcement}</p>
{#if held}<p role="status" data-testid="advance-held">{t(M[held === 'unsent' ? 'ingestion.finishedUnsent' : held === 'failed' ? 'ingestion.advanceFailed' : 'ingestion.advanceRetry'])}</p>{/if}
{#if leaving}<div class="leave" role="group" aria-labelledby="unsaved-leave-note" bind:this={stay} data-testid="unsaved-leave"><p id="unsaved-leave-note">{t(M['ingestion.unsavedLeave'])}</p><Button data-stay onclick={keepEditing}>{t(M['ingestion.stay'])}</Button><Button onclick={discardAndLeave}>{t(M['ingestion.discardLeave'])}</Button></div>{/if}
{#if selected}
{#key selected}<ReviewView {host} itemId={selected} {pollMs} layout="stacked" onview={paneChanged} ondirty={(dirty: boolean) => { paneDirty = dirty; }} onoutcome={outcome} />{/key}
{:else if done}<p role="status" data-testid="queue-done">{t(M['ingestion.queueDone'])}</p>
{:else}<p>{t(M['ingestion.selectItem'])}</p>{/if}
</section>
</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
.workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;color:var(--smrt-color-on-surface)}.list-pane,.item-pane{min-width:0}.item-pane{outline-offset:.25rem}.queue-nav{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding-inline:1rem}.queue-nav p,.hint{margin:0}.leave{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.75rem 1rem;border:var(--smrt-hairline)}.leave p{margin:0;flex-basis:100%}.hint{padding-inline:1rem;font-size:.875rem}[data-testid='background-update']{padding-inline:1rem;margin:0}@media(min-width:64rem){.workspace{grid-template-columns:minmax(18rem,26rem) minmax(0,1fr)}.list-pane{position:sticky;inset-block-start:0;align-self:start;max-block-size:100vh;overflow:auto}}
}
</style>
