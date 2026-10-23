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
const displayed = (id: string) => rows.some((row) => row.item.id === id);
/**
 * Read sequence: every read (a page, a pane view, a follow read) takes the
 * next number when its request STARTS, and every entry held for a row keeps
 * the number of the read that produced it, so a newer read always wins over
 * an older one, whatever its source.
 */
let sequence = 0;
const stamp = () => ++sequence;
type Held = { entry: InboxEntry; read: number };
// Each row's entry exactly as a page read returned it (never a patched
// entry): the state a row falls back to.
let listedEntries = new Map<string, Held>();
// The newest entry known for each row, from any read.
let newest = new Map<string, Held>();
// Per-item follow generation, bumped whenever a follow stops or starts: a
// follow read answering for an earlier generation is dropped.
const generation = new Map<string, number>();
// The read that produced the pane view.
let paneRead = 0;
const bump = (id: string) => generation.set(id, (generation.get(id) ?? 0) + 1);
let listEpoch = 0;
function readStarted() {
  listEpoch++;
}
/**
 * Extra settled reads still owed to a reviewer operation the pane had not
 * answered when the item was left (an Apply): the item keeps following while
 * a read still shows an action authorized or executing, at most
 * OPERATION_READS more reads. The debt belongs to the operation, so it
 * survives reopening and leaving the item again, until a view shows the
 * operation answered or the reads run out. Leaving mid-operation again (a
 * new operation the pane has not answered) resets the debt to the full
 * OPERATION_READS, whatever was left of the earlier one.
 */
const OPERATION_READS = 3;
const operationReads = new Map<string, number>();
const operationPending = (view: ItemReviewView) =>
  view.reviews.actions.some((action) =>
    ['authorized', 'executing'].includes(action.review.state),
  );

// Row bookkeeping, one function per lifecycle event. Each keeps `statuses`,
// `newest`, the follow sets (`watched`, `started`, `staged`, `failures`,
// `generation`, `operationReads`), the announcement and the row together.

/** Stop following an item; what its row shows is left to the caller. */
function stopFollowing(id: string) {
  watched = watched.filter((entry) => entry !== id);
  started = started.filter((entry) => entry !== id);
  failures.delete(id);
  staged.delete(id);
  bump(id);
}
/**
 * Forget everything loaded views said about an item: it is no longer
 * followed, has no cached status or owed operation reads, and (`restore`)
 * its row returns to the entry exactly as its page read returned it.
 */
function forget(id: string, restore: boolean) {
  stopFollowing(id);
  operationReads.delete(id);
  delete statuses[id];
  newest.delete(id);
  const listed = listedEntries.get(id);
  if (restore && listed && inbox) {
    newest.set(id, listed);
    rows = inbox.patch(listed.entry, true);
  }
}
/**
 * Show a read's entry on its row unless a newer read already did; a row the
 * filter removes is forgotten. Returns whether the entry was applied.
 */
function show(entry: InboxEntry, read: number, keep: boolean) {
  const id = entry.item.id;
  if (read < (newest.get(id)?.read ?? 0) || !inbox) return false;
  newest.set(id, { entry, read });
  rows = inbox.patch(entry, keep);
  if (!displayed(id)) rowRemoved(id);
  return true;
}
/** Cache a view's status (valid only while the row shows its entry) and show it. */
function showView(view: ItemReviewView, read: number, keep: boolean) {
  const id = view.entry.item.id;
  if (read < (newest.get(id)?.read ?? 0)) return;
  statuses[id] = { key: fingerprint(view.entry), status: viewStatus(view) };
  show(view.entry, read, keep);
}
/** Event: a row left the displayed list (filter, refresh, failed list). */
function rowRemoved(id: string) {
  forget(id, false);
}
/**
 * Event: an item opens in the pane. It is no longer followed and its row
 * shows its entry's own state until the pane's first view; a debt of
 * operation reads stays with the operation.
 */
function opened(id: string) {
  stopFollowing(id);
  delete statuses[id];
}
/**
 * Event: the reviewer left an item. Its row takes the listed filter; an item
 * left mid-stage, before the pane showed the result of its latest operation,
 * or with operation reads still owed, keeps following while its row is
 * displayed.
 */
function left(id: string, view: ItemReviewView | undefined, busy: boolean) {
  if (view) show(view.entry, paneRead, false);
  if (!displayed(id)) {
    rowRemoved(id);
    return;
  }
  const running = reviewInFlight(view);
  // A new unanswered operation owes its own full set of reads.
  if (busy) operationReads.set(id, OPERATION_READS);
  if (!busy && !running && !operationReads.has(id)) return;
  if (watched.includes(id)) return;
  bump(id);
  if (running) staged.add(id);
  watched = [...watched, id];
  started = [...started, id];
  // Beyond the cap the longest-followed item (the earliest started, whatever
  // the read rotation) stops and returns to its listed entry.
  while (started.length > WATCH_CAP) forget(started[0], true);
  // The backoff carries on; only an idle follower starts a tick (a running
  // tick, or one already scheduled, picks the new item up).
  if (!following && watchTimer === undefined) schedule();
}
/** Event: the open pane, or a follow read, was denied (returned or thrown). */
function denied(id: string) {
  if (id === selected) {
    paneView = undefined;
    paneBusy = false;
  }
  forget(id, true);
  announcement = '';
}
/** Event: a current-generation follow read answered for a followed item. */
function followed(view: ItemReviewView, read: number) {
  const id = view.entry.item.id;
  failures.delete(id);
  // A read older than what the row already shows (a page listed it after
  // this read started) decides nothing: no stop, no status, no announcement.
  // Following continues and a newer read settles it.
  if (read < (newest.get(id)?.read ?? 0)) return;
  const running = reviewInFlight(view);
  if (running) staged.add(id);
  // A reviewer operation the pane had not answered yet (left mid-Apply) is
  // waited for while an action is still authorized or executing.
  const owed = operationReads.get(id) ?? 0;
  const waiting = owed > 0 && operationPending(view);
  if (waiting) operationReads.set(id, owed - 1);
  else operationReads.delete(id);
  const finished = !running && !waiting;
  const announce = finished && staged.has(id);
  if (finished) stopFollowing(id);
  showView(view, read, false);
  // Announce only a background stage that was seen running and has now
  // settled, on a row still displayed, under its listed label.
  if (announce && displayed(id))
    announcement = t(M['ingestion.backgroundUpdate'], {
      label: rows.find((row) => row.item.id === id)?.label ?? view.entry.label,
      status: statusText(viewStatus(view)),
    });
}
/** Event: a follow read threw; three in a row stop following. */
function followFailed(id: string) {
  const count = (failures.get(id) ?? 0) + 1;
  failures.set(id, count);
  if (count >= MAX_WATCH_FAILURES) forget(id, true);
}
/** Event: a page read landed (a refresh replaces, Load more appends). */
function pageLanded(page: {
  entries: InboxEntry[];
  appended: boolean;
  issued?: number;
}) {
  const read = page.issued ?? 0;
  if (!page.appended) {
    listedEntries = new Map();
    announcement = '';
  }
  for (const entry of page.entries)
    listedEntries.set(entry.item.id, { entry, read });
  if (!inbox) return;
  // Each listed row shows whichever is newer: this page's entry, or an entry
  // a later-started read (the pane, a follow read) already produced.
  for (const entry of page.entries) {
    const id = entry.item.id;
    const known = newest.get(id);
    if (known && known.read > read) {
      if (displayed(id))
        rows = inbox.patch(known.entry, id === paneView?.entry.item.id);
    } else {
      newest.set(id, { entry, read });
      delete statuses[id];
    }
  }
  for (const id of [...newest.keys()]) if (!displayed(id)) newest.delete(id);
  for (const id of [...watched]) if (!displayed(id)) rowRemoved(id);
}
/** Event: a page read failed and the list failed closed (no rows). */
function listFailed() {
  for (const id of [...watched]) forget(id, false);
  newest = new Map();
  operationReads.clear();
  announcement = '';
}
function listed(
  items: InboxEntry[],
  hasMore: boolean,
  page?: { entries: InboxEntry[]; appended: boolean; issued?: number },
) {
  rows = items;
  more = hasMore;
  if (page) pageLanded(page);
  else listFailed();
}
function paneChanged(
  view: ItemReviewView | undefined,
  refused = false,
  issued = 0,
) {
  if (!view) {
    // A failed callback (or a first load that failed) cleared the pane: it
    // fails closed, so nothing it showed stays on the row or is followed.
    if (refused) {
      if (selected) denied(selected);
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
  if (snapshot.availability !== 'available') {
    denied(snapshot.entry.item.id);
    return;
  }
  paneView = snapshot;
  paneRead = issued;
  // The pane itself shows whether an operation left owed reads has answered.
  if (!operationPending(snapshot))
    operationReads.delete(snapshot.entry.item.id);
  // The open item stays listed while the reviewer works on it, even if its
  // state no longer matches the filter; it leaves when they move on.
  showView(snapshot, issued, true);
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
/**
 * One watch tick: re-read up to WATCH_LIMIT followed items through the same
 * authenticated `load` the item pane uses (first review page only), one
 * after another, least recently read first, on the pane's backoff.
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
    // An answer is used only by the follow that asked for it.
    const asked = generation.get(id) ?? 0;
    const current = () =>
      watched.includes(id) && (generation.get(id) ?? 0) === asked;
    const read = stamp();
    try {
      const requestedAt = listEpoch;
      const view = await host.load(id);
      if (!alive) return;
      if (!current()) continue;
      if (view.availability !== 'available') denied(id);
      else if (requestedAt === listEpoch) followed(view, read);
    } catch {
      if (!alive) return;
      if (current()) followFailed(id);
    }
  }
}
/** Open an item in the pane; the previous one keeps following its stage if in flight. */
async function choose(id: string | undefined, focus: boolean) {
  if (id !== selected) {
    const previous = paneView;
    const leaving_ = selected;
    const busy = paneBusy;
    paneView = undefined;
    paneBusy = false;
    if (leaving_)
      left(
        leaving_,
        previous?.entry.item.id === leaving_ ? previous : undefined,
        busy,
      );
    if (id) opened(id);
    selected = id;
    navigation++;
    paneDirty = false;
    leaving = undefined;
    held = undefined;
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
/**
 * Where to continue after `current` in a list that may have changed while a
 * page loaded: just after it when it is still listed; otherwise at the first
 * row that followed it before and is still listed; otherwise at the first
 * row that is new; otherwise at the end. Positions are found by id, never by
 * an index taken before the change.
 */
function resume(
  before: readonly InboxEntry[],
  current: string | undefined,
  list: readonly InboxEntry[],
) {
  const ids = list.map((row) => row.item.id);
  const at = current ? ids.indexOf(current) : -1;
  if (at >= 0) return at + 1;
  const old = before.map((row) => row.item.id);
  const from = current ? old.indexOf(current) : -1;
  for (const id of old.slice(from + 1)) {
    const index = ids.indexOf(id);
    if (index >= 0) return index;
  }
  const known = new Set(old);
  const fresh = ids.findIndex((id) => !known.has(id));
  return fresh >= 0 ? fresh : ids.length;
}
async function move(offset: 1 | -1) {
  const ticket = navigation;
  const current = selected;
  const before = rows;
  const index = before.findIndex((row) => row.item.id === current);
  let target =
    index < 0
      ? offset > 0
        ? before[0]
        : before.at(-1)
      : before[index + offset];
  if (!target && offset > 0 && more && inbox) {
    const page = await inbox.more();
    // The reviewer chose something else while the page loaded.
    if (ticket !== navigation) return;
    target = page.items[index < 0 ? 0 : resume(before, current, page.items)];
  }
  if (target) await request(target.item.id);
}
/** After an item is finished: drop it under the filter and open the next open item. */
async function advance() {
  const ticket = navigation;
  const current = selected;
  const before = rows;
  let list = paneView && inbox ? inbox.patch(paneView.entry, true) : rows;
  rows = list;
  let start = resume(before, current, list);
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
    const count = list.length;
    const page = await inbox.more();
    if (!alive || ticket !== navigation) return;
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
    // Rows may have left while the page loaded: continue by id.
    start = resume(before, current, list);
    next = list.slice(start).find(open);
    // No progress (for example a denied page) must not spin on a host callback.
    if (list.length <= count) {
      unknown = more ? 'retry' : undefined;
      break;
    }
  }
  next ??= list.slice(0, start).find(open);
  if (!next && unknown) {
    held = unknown;
    return;
  }
  if (paneDirty) {
    held = 'unsent';
    return;
  }
  await choose(next?.item.id, true);
}
function outcome(_kind: ReviewOutcome, view: ItemReviewView) {
  if (view.entry.item.id !== selected) return;
  paneChanged(view, false, paneRead);
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
<InboxView bind:this={inbox} {host} {rowAside} selectedId={selected} onselect={(id) => request(id)} onitems={listed} onreadstart={readStarted} {stamp} status={rowStatus} resolveInRow={false} />
</div>
<section class="item-pane" bind:this={pane} tabindex="-1" aria-label={label ?? t(M['ingestion.selectedItem'])} data-testid="workspace-item" onfocusin={noteField}>
<div class="queue-nav" role="group" aria-label={t(M['ingestion.workspace'])}>
<Button disabled={position === 0 || !rows.length} aria-keyshortcuts="K Alt+ArrowUp" onclick={() => move(-1)}>{t(M['ingestion.previousItem'])}</Button>
{#if position >= 0}<p data-testid="queue-position">{t(M['ingestion.itemOf'], { index: position + 1, count: rows.length })}</p>{/if}
<Button disabled={(position >= rows.length - 1 && !more) || !rows.length} aria-keyshortcuts="J Alt+ArrowDown" onclick={() => move(1)}>{t(M['ingestion.nextItem'])}</Button>
</div>
<p class="hint">{t(M['ingestion.keyboardHelp'])}</p>
<p role="status" data-testid="background-update">{announcement}</p>
<!-- One persistent live region whose text changes, so the notes are announced reliably. -->
<p role="status" class="pane-note" data-testid="pane-note">{#if held}<span data-testid="advance-held">{t(M[held === 'unsent' ? 'ingestion.finishedUnsent' : held === 'failed' ? 'ingestion.advanceFailed' : 'ingestion.advanceRetry'])}</span>{:else if done && !selected}<span data-testid="queue-done">{t(M['ingestion.queueDone'])}</span>{/if}</p>
{#if leaving}<div class="leave" role="group" aria-labelledby="unsaved-leave-note" bind:this={stay} data-testid="unsaved-leave"><p id="unsaved-leave-note">{t(M['ingestion.unsavedLeave'])}</p><Button data-stay onclick={keepEditing}>{t(M['ingestion.stay'])}</Button><Button onclick={discardAndLeave}>{t(M['ingestion.discardLeave'])}</Button></div>{/if}
{#if selected}
{#key selected}<ReviewView {host} itemId={selected} {pollMs} layout="stacked" {stamp} onview={paneChanged} ondirty={(dirty: boolean) => { paneDirty = dirty; }} onoutcome={outcome} />{/key}
{:else if !done}<p>{t(M['ingestion.selectItem'])}</p>{/if}
</section>
</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
.workspace{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;color:var(--smrt-color-on-surface)}.list-pane,.item-pane{min-width:0}.item-pane{outline-offset:.25rem}.queue-nav{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding-inline:1rem}.queue-nav p,.hint{margin:0}.leave{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.75rem 1rem;border:var(--smrt-hairline)}.leave p{margin:0;flex-basis:100%}.hint{padding-inline:1rem;font-size:.875rem}[data-testid='background-update'],.pane-note{padding-inline:1rem;margin:0}@media(min-width:64rem){.workspace{grid-template-columns:minmax(18rem,26rem) minmax(0,1fr)}.list-pane{position:sticky;inset-block-start:0;align-self:start;max-block-size:100vh;overflow:auto}}
}
</style>
