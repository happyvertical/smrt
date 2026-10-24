<script lang="ts">
import { Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, onMount, untrack } from 'svelte';
import type { EvidenceLocation } from '../../extraction-types.js';
import type {
  GeneratedSuggestion,
  ProposalCatalogEntry,
} from '../../proposal-dto.js';
import type { IntakeReviewHost, ItemReviewView } from '../../review-dto.js';
import { M } from '../i18n.js';
import {
  argumentsObject,
  draftArguments,
  evidenceUrl,
  extractedContent,
  missingArguments,
  missingRequired,
  observedPages,
  pageGroups,
  reviewInFlight,
} from '../view-utils.js';
import ActionReview, { type ReviewOutcome } from './ActionReview.svelte';
import CandidatePicker from './CandidatePicker.svelte';
import EvidenceViewer from './EvidenceViewer.svelte';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
  /** Reload interval while the host reports the item as processing. */
  pollMs?: number;
  /** `split` puts the original beside the form; `stacked` puts it above, one part at a time. */
  layout?: 'split' | 'stacked';
  /**
   * Every displayed view (load, in-place poll patch, denial projection), and
   * `undefined` when a displayed view is cleared for a reload or an operation
   * whose result has not been shown yet. `denied` is true when it was cleared
   * because a callback failed (the view fails closed), not for a reload.
   * Presentation only.
   */
  onview?: (
    view: ItemReviewView | undefined,
    denied: boolean,
    issued: number,
  ) => void;
  /** Numbers each load when its request starts; reported as `issued` with the view. */
  stamp?: () => number;
  /** Whether the reviewer has unsent input on this item. */
  ondirty?: (dirty: boolean) => void;
  /** After an approve, apply or resolve and the reload that follows it succeeded. */
  onoutcome?: (outcome: ReviewOutcome, view: ItemReviewView) => void;
}
let {
  host,
  itemId,
  pollMs = 2000,
  layout = 'split',
  onview,
  stamp,
  ondirty,
  onoutcome,
}: Props = $props();
const { t } = useI18n();
let view = $state<ItemReviewView>(),
  pending = $state(false),
  error = $state(false),
  splits = $state<Record<string, string>>({}),
  instruction = $state(''),
  refreshFailed = $state(false),
  instructionBusy = $state(false),
  // The draft the server refused as invalid; the note stays until it changes.
  invalidDraft = $state<string>(),
  // The draft a stale result left unrecorded; the note stays until the
  // reviewer edits or resubmits it.
  unrecordedDraft = $state<string>(),
  // Human drafts for `needs_review` suggestions, keyed by `attemptId:index`.
  // They survive refresh, failures and actions on other cards and are cleared
  // only by a successful preview of their own card.
  drafts = $state<Record<string, string>>({}),
  // Drafts the reviewer tried to preview while unparsable; the alert clears
  // as soon as the draft parses again.
  invalidDrafts = $state<Record<string, true>>({}),
  // Suggestion whose last preview the host rejected; its draft is kept.
  previewRejected = $state<number>(),
  invalid = $state(false);
/** Same ceiling the server enforces (REVIEWER_INSTRUCTION_MAX_LENGTH). */
const INSTRUCTION_MAX_LENGTH = 4000;
const instructionValid = $derived(
  !!instruction.trim() && instruction.length <= INSTRUCTION_MAX_LENGTH,
);
// The busy note after a stale click stays only while the item is still in
// flight; any reload (including the one answering the click) that shows it
// settled clears it.
function settleBusy() {
  if (instructionBusy && !inFlight(view)) instructionBusy = false;
}
/** Consecutive thrown poll ticks tolerated before failing closed. */
const MAX_POLL_FAILURES = 3;
let alive = true,
  epoch = 0,
  loadedPages = 1,
  poll: ReturnType<typeof setTimeout> | undefined,
  pollTicks = 0,
  pollFailures = 0;
onDestroy(() => {
  alive = false;
  epoch++;
  clearTimeout(poll);
});
// Includes the server's own predicate, which also covers the gap between a
// completed extraction and its not-yet-appended interpretation.
const inFlight = reviewInFlight;
// Parents follow the displayed view (a workspace keeps its list row in step);
// untracked so the callback's own reads never re-run this effect. Undefined
// means a displayed view was cleared for a reload or an operation.
let shown = false;
// The read sequence number of the load that produced the displayed view.
let viewIssued = 0;
$effect(() => {
  const current = view;
  // Read too, so a denial after an operation cleared the view still reports.
  const denied = !current && error;
  // A first load that failed reports its denial too.
  if (!current && !shown && !denied) return;
  shown = true;
  untrack(() => onview?.(current, denied, viewIssued));
});
// Unsent reviewer input on this item (instruction, drafts, split edits,
// start/resolve fields, action editors); a workspace confirms before leaving.
// It is read from the drafts themselves, against the text each draft started
// from, so it holds while a reload has cleared the view. While the view is
// denied nothing is shown, so nothing counts: the reviewer is never asked to
// discard input they cannot see (it is kept, and returns with an authorized
// refresh, as before).
let actionDirty = $state<Record<string, boolean>>({}),
  // The generated text each suggestion draft and split draft started from.
  draftBase = $state<Record<string, string>>({}),
  splitBase = $state<Record<string, string>>({});
const dirty = $derived(
  (view ? view.availability === 'available' : !error) &&
    (!!instruction.trim() ||
      editedFields() ||
      Object.values(actionDirty).some(Boolean) ||
      Object.entries(drafts).some(([key, draft]) => draft !== draftBase[key]) ||
      Object.entries(splits).some(([id, draft]) => draft !== splitBase[id])),
);
/** Start-action and resolve fields (declared with their controls below). */
function editedFields() {
  return !!resolveReason || !!startHandler || !!startReason;
}
// Split drafts start from the generation's groups whenever a view shows them.
$effect(() => {
  const current = view;
  if (current)
    splitBase = Object.fromEntries(
      (current.generation?.splits ?? []).map((split) => [
        split.evidenceId,
        JSON.stringify(split.groups),
      ]),
    );
});
// A closed item takes no instruction, suggestion, split or started action, so
// such input left when it closed can never be sent: it is discarded rather
// than kept as unsent work.
$effect(() => {
  if (view?.availability !== 'available' || !view.entry.item.disposition)
    return;
  untrack(() => {
    instruction = '';
    drafts = {};
    draftBase = {};
    startHandler = '';
    startArgs = '';
    startReason = '';
    startRejected = false;
    startIssues = [];
    splits = {};
    resolveReason = '';
  });
});
$effect(() => {
  const current = dirty;
  untrack(() => ondirty?.(current));
});
// The original's chosen part and pages outlive in-place reloads and
// operations (the viewer itself unmounts while a reload is pending).
let viewerPart = $state<string>(),
  viewerPages = $state<Record<string, number>>({});
/** Prefer the server's retry binding; otherwise the displayed generation. */
function instructionBinding(current: ItemReviewView | undefined) {
  if (current?.instruction?.binding) return current.instruction.binding;
  return current?.generation && current.analysis
    ? {
        attemptId: current.analysis.attemptId,
        expectedRevision: current.analysis.revision,
      }
    : undefined;
}
// Background stages (reinterpretation after an instruction) finish without a
// push channel; the authenticated load is repeated and patched in place so
// drafts, focus and the evidence viewer survive. The delay backs off to 5x.
function schedulePoll(ticket: number) {
  clearTimeout(poll);
  if (!inFlight(view)) {
    pollTicks = 0;
    return;
  }
  const delay = Math.min(pollMs * 1.5 ** pollTicks, pollMs * 5);
  pollTicks++;
  poll = setTimeout(() => {
    if (alive && ticket === epoch && !pending) void refresh(ticket);
  }, delay);
}
function deny() {
  epoch++;
  clearTimeout(poll);
  view = undefined;
  splits = {};
  // Drafts are the reviewer's own typed text, never host data: they are kept
  // in memory (nothing renders while the view is denied) so a failed refresh
  // or a failed action on another card does not discard them.
  error = true;
  pending = false;
}
/** Aggregate the displayed pages with fresh cursors; returns undefined when fenced. */
async function fetchView(
  ticket: number,
  pageCount: number,
): Promise<
  { result: ItemReviewView; pages: number; issued: number } | undefined
> {
  const issued = stamp?.() ?? 0;
  let cursor: string | undefined;
  let result: ItemReviewView | undefined;
  const actions: ItemReviewView['reviews']['actions'] = [];
  const actionIds = new Set<string>();
  const cursors = new Set<string>();
  let refreshedPages = 0;
  for (let index = 0; index < pageCount; index++) {
    const page = await host.load(itemId, cursor);
    if (!alive || ticket !== epoch) return undefined;
    if (page.availability !== 'available') {
      result = page;
      break;
    }
    if (
      result &&
      page.entry.item.analysisRevision !== result.entry.item.analysisRevision
    )
      throw new Error('Review changed during pagination');
    result ??= page;
    for (const action of page.reviews.actions) {
      if (!actionIds.has(action.review.actionId)) {
        actionIds.add(action.review.actionId);
        actions.push(action);
      }
    }
    refreshedPages++;
    cursor = page.reviews.nextCursor;
    if (!cursor) break;
    if (cursors.has(cursor)) throw new Error('Repeated review cursor');
    cursors.add(cursor);
  }
  if (!result) throw new Error('Missing review page');
  if (result.availability === 'available')
    result = {
      ...result,
      reviews: { ...result.reviews, actions, nextCursor: cursor },
    };
  // A host denial must not leave any original, candidate, or argument in the DOM.
  return {
    result:
      result.availability === 'available'
        ? result
        : {
            entry: result.entry,
            evidence: [],
            reviews: { actions: [] },
            availability: result.availability,
          },
    pages: refreshedPages,
    issued,
  };
}
/** Keep only drafts the reviewer edited; untouched ones follow the new generation. */
function splitDrafts(
  next: ItemReviewView,
  keep: Record<string, string>,
  previous?: ItemReviewView,
) {
  const generated = new Map(
    (previous?.generation?.splits ?? []).map((split) => [
      split.evidenceId,
      JSON.stringify(split.groups),
    ]),
  );
  return Object.fromEntries(
    (next.generation?.splits ?? []).map((split) => {
      const draft = keep[split.evidenceId];
      const edited =
        draft !== undefined && draft !== generated.get(split.evidenceId);
      return [split.evidenceId, edited ? draft : JSON.stringify(split.groups)];
    }),
  );
}
function syncSuggestionDrafts(current: ItemReviewView) {
  // Drafts follow availability: revoked or expired access discards them;
  // a transient `unavailable` or `stale` result keeps them (nothing renders
  // meanwhile) so the reviewer's typing survives until the view returns;
  // an available view prunes drafts of attempts or cards no longer offered.
  if (
    current.availability === 'revoked' ||
    current.availability === 'expired'
  ) {
    drafts = {};
    draftBase = {};
    invalidDrafts = {};
  } else if (current.availability === 'available') {
    const attemptId = current.analysis?.attemptId;
    const keys = new Set<string>();
    (current.generation?.suggestions ?? []).forEach((suggestion, index) => {
      if (!attemptId || suggestion.disposition !== 'needs_review') return;
      const key = `${attemptId}:${index}`;
      keys.add(key);
      const generated = JSON.stringify(suggestion.args, null, 2);
      drafts[key] ??= generated;
      draftBase[key] ??= generated;
    });
    for (const key of Object.keys(drafts))
      if (!keys.has(key)) {
        delete drafts[key];
        delete draftBase[key];
        delete invalidDrafts[key];
      }
  }
}
async function load(pageCount = loadedPages) {
  const ticket = ++epoch;
  clearTimeout(poll);
  pollTicks = 0;
  pollFailures = 0;
  refreshFailed = false;
  view = undefined;
  splits = {};
  previewRejected = undefined;
  pending = true;
  error = false;
  invalid = false;
  try {
    const fetched = await fetchView(ticket, pageCount);
    if (!fetched) return;
    if (fetched.result.availability === 'available')
      loadedPages = fetched.pages;
    viewIssued = fetched.issued;
    view = fetched.result;
    syncSuggestionDrafts(view);
    splits = splitDrafts(view, {});
    settleBusy();
  } catch {
    if (alive && ticket === epoch) deny();
  } finally {
    if (alive && ticket === epoch) {
      pending = false;
      schedulePoll(ticket);
    }
  }
}
/** Poll tick: patch the view in place without blanking it or resetting drafts. */
async function refresh(ticket: number) {
  try {
    const fetched = await fetchView(ticket, loadedPages);
    if (!fetched || !alive || ticket !== epoch) return;
    pollFailures = 0;
    refreshFailed = false;
    // An explicit host denial fails closed at once.
    if (fetched.result.availability !== 'available') {
      viewIssued = fetched.issued;
      view = fetched.result;
      syncSuggestionDrafts(view);
      splits = {};
      return;
    }
    if (JSON.stringify(fetched.result) !== JSON.stringify(view)) {
      loadedPages = fetched.pages;
      splits = splitDrafts(fetched.result, splits, view);
      viewIssued = fetched.issued;
      view = fetched.result;
      syncSuggestionDrafts(view);
    } else if (view) {
      // Unchanged, but read again: the displayed view is this fresh.
      viewIssued = fetched.issued;
      const current = view;
      untrack(() => onview?.(current, false, viewIssued));
    }
    settleBusy();
  } catch {
    if (!alive || ticket !== epoch) return;
    // A thrown tick may be transient: keep the view and keep backing off, but
    // a host may also throw for revoked access, so fail closed after a bound.
    pollFailures++;
    if (pollFailures >= MAX_POLL_FAILURES) {
      refreshFailed = false;
      deny();
      return;
    }
    refreshFailed = true;
  } finally {
    if (alive && ticket === epoch && !pending) schedulePoll(ticket);
  }
}
async function run(operation: () => Promise<unknown>, outcome?: ReviewOutcome) {
  if (pending) return;
  const ticket = ++epoch;
  clearTimeout(poll);
  pending = true;
  error = false;
  view = undefined;
  splits = {};
  try {
    await operation();
    if (!alive || ticket !== epoch) return;
    await load();
    // Only the reload that answered this operation reports its outcome.
    // `load` reassigned the view; TypeScript still narrows it to undefined.
    const settled = view as ItemReviewView | undefined;
    if (
      outcome &&
      alive &&
      ticket + 1 === epoch &&
      settled?.availability === 'available'
    )
      onoutcome?.(outcome, settled);
  } catch {
    if (alive && ticket === epoch) deny();
  }
}
function offeredHandler(suggestion: GeneratedSuggestion) {
  return view?.generation?.offered.find(
    (entry) =>
      entry.handler.id === suggestion.handlerId &&
      entry.handler.version === suggestion.handlerVersion,
  )?.handler;
}
// Presentation only: the host rechecks stage, outcome, handler and authority.
function previewable(suggestion: GeneratedSuggestion) {
  return (
    !view?.entry.item.disposition &&
    !!view?.analysis &&
    view.generation?.outcome !== 'provider_error' &&
    ['ready_for_review', 'needs_review'].includes(suggestion.disposition)
  );
}
function draftKey(index: number) {
  return `${view?.analysis?.attemptId ?? ''}:${index}`;
}
function parseable(draft: string | undefined) {
  if (draft === undefined) return false;
  try {
    argumentsObject(draft);
    return true;
  } catch {
    return false;
  }
}
function edited(index: number) {
  const suggestion = view?.generation?.suggestions[index];
  const draft = drafts[draftKey(index)];
  return (
    !!suggestion &&
    draft !== undefined &&
    draft !== JSON.stringify(suggestion.args, null, 2)
  );
}
// Every schema-required argument must be present in the draft before preview;
// the host and handler still validate the published arguments.
function canPreview(index: number) {
  const suggestion = view?.generation?.suggestions[index];
  if (!suggestion || !previewable(suggestion)) return false;
  if (suggestion.disposition !== 'needs_review') return true;
  const draft = drafts[draftKey(index)];
  if (draft === undefined) return false;
  if (suggestion.missingFields.length && !edited(index)) return false;
  const handler = offeredHandler(suggestion);
  return !handler || !missingRequired(handler.argsSchema, draft).length;
}
async function preview(index: number) {
  const analysis = view?.analysis;
  const suggestion = view?.generation?.suggestions[index];
  if (pending || !analysis || !suggestion || !canPreview(index)) return;
  let args: Record<string, unknown> | undefined;
  const key = draftKey(index);
  if (suggestion.disposition === 'needs_review' && edited(index)) {
    try {
      args = argumentsObject(drafts[key]);
    } catch {
      invalidDrafts[key] = true;
      return;
    }
  }
  const input = {
    itemId,
    attemptId: analysis.attemptId,
    index,
    requestId: crypto.randomUUID(),
    ...(args ? { args } : {}),
  };
  // Only the handler's validation refusal stays inline and keeps the view:
  // a resolved `{ rejected: 'invalid' }` or a thrown error named
  // `HandlerArgumentsInvalidError`. Anything else fails closed.
  const ticket = ++epoch;
  pending = true;
  error = false;
  previewRejected = undefined;
  try {
    const outcome = await host.preview(input);
    if (!alive || ticket !== epoch) return;
    if (outcome?.rejected === 'invalid') {
      previewRejected = index;
      pending = false;
      return;
    }
    // Only a successful preview of this card consumes its draft.
    delete drafts[key];
    delete draftBase[key];
    delete invalidDrafts[key];
    await load();
  } catch (error) {
    if (!alive || ticket !== epoch) return;
    if (
      (error as { name?: unknown } | null)?.name ===
      'HandlerArgumentsInvalidError'
    ) {
      previewRejected = index;
      pending = false;
      return;
    }
    deny();
  }
}
function chooseFor(index: number) {
  return (field: string, id: string) => {
    const key = draftKey(index);
    try {
      drafts[key] = JSON.stringify(
        { ...argumentsObject(drafts[key] ?? '{}'), [field]: id },
        null,
        2,
      );
    } catch {
      invalidDrafts[key] = true;
    }
  };
}
function split(evidenceId: string) {
  const analysis = view?.analysis;
  if (!view?.generation || !analysis) return;
  let groups: number[][];
  try {
    groups = pageGroups(splits[evidenceId]);
  } catch {
    invalid = true;
    return;
  }
  const input = {
    itemId,
    attemptId: analysis.attemptId,
    expectedRevision: analysis.revision,
    evidenceId,
    groups,
    requestId: crypto.randomUUID(),
  };
  void run(() => host.split(input));
}
// Reviewer-chosen action and no-action disposition. Presentation only; the
// server previews, checks reviewer authority and requires separate approval.
let startHandler = $state(''),
  startArgs = $state(''),
  startReason = $state(''),
  startInvalid = $state(false),
  // The handler refused the reviewer's arguments: the form and draft stay;
  // `startIssues` holds the bounded, value-free field paths when known.
  startRejected = $state(false),
  startIssues = $state<string[]>([]),
  resolveReason = $state('');
const startEntry = $derived.by((): ProposalCatalogEntry | undefined =>
  view?.catalog?.find(
    (entry) =>
      entry.kind === 'operation' &&
      `${entry.id}@${entry.version}` === startHandler,
  ),
);
const startMissing = $derived.by((): string[] => {
  if (!startEntry) return [];
  try {
    return missingArguments(startEntry, argumentsObject(startArgs));
  } catch {
    return [];
  }
});
function draftStart() {
  startInvalid = false;
  startRejected = false;
  startIssues = [];
  const entry = view?.catalog?.find(
    (candidate) => `${candidate.id}@${candidate.version}` === startHandler,
  );
  startArgs = entry
    ? JSON.stringify(
        draftArguments(
          entry,
          view?.generation?.suggestions ?? [],
          view?.evidence.map((part) => part.evidence.id) ?? [],
        ),
        null,
        2,
      )
    : '';
}
/**
 * Distinct schema-owned field paths of a typed refusal; never values. A root
 * path `/name` shows as the bare (unescaped) name, like `missingFields`;
 * nested paths stay escaped pointers and `/` (the whole object) stays `/`.
 */
function refusedFields(issues: unknown): string[] {
  if (!Array.isArray(issues)) return [];
  const paths = new Set<string>();
  for (const issue of issues.slice(0, 20)) {
    const path = (issue as { path?: unknown } | null)?.path;
    if (typeof path !== 'string' || !path || path.length > 160) continue;
    paths.add(
      /^\/[^/]+$/.test(path)
        ? path.slice(1).replace(/~1/g, '/').replace(/~0/g, '~')
        : path,
    );
  }
  return [...paths];
}
async function startAction() {
  const entry = startEntry;
  if (!entry || !view?.analysis || !host.startAction || pending) return;
  let args: Record<string, unknown>;
  startRejected = false;
  startIssues = [];
  try {
    args = argumentsObject(startArgs);
  } catch {
    startInvalid = true;
    return;
  }
  startInvalid = false;
  const input = {
    itemId,
    handlerId: entry.id,
    handlerVersion: entry.version,
    args,
    requestId: crypto.randomUUID(),
    ...(startReason ? { reason: startReason } : {}),
  };
  const start = host.startAction;
  // Like `preview`: only the handler's refusal of the arguments (a resolved
  // `{ rejected: 'invalid' }` or a thrown `HandlerArgumentsInvalidError`)
  // keeps the view, form and draft inline. Anything else fails closed.
  const ticket = ++epoch;
  clearTimeout(poll);
  pending = true;
  error = false;
  let refusal: unknown;
  try {
    const outcome = await start(input);
    if (!alive || ticket !== epoch) return;
    if (outcome?.rejected === 'invalid') refusal = outcome;
  } catch (caught) {
    if (!alive || ticket !== epoch) return;
    if (
      (caught as { name?: unknown } | null)?.name !==
      'HandlerArgumentsInvalidError'
    ) {
      deny();
      return;
    }
    refusal = caught;
  }
  if (refusal) {
    startRejected = true;
    startIssues = refusedFields((refusal as { issues?: unknown }).issues);
    pending = false;
    schedulePoll(ticket);
    return;
  }
  startHandler = '';
  startArgs = '';
  startReason = '';
  await load();
}
function resolve() {
  if (!host.resolve) return;
  const input = {
    itemId,
    disposition: 'resolve_no_action' as const,
    requestId: crypto.randomUUID(),
    ...(resolveReason ? { reason: resolveReason } : {}),
  };
  const close = host.resolve;
  void run(async () => {
    await close(input);
    resolveReason = '';
  }, 'resolve');
}
function instruct() {
  const binding = instructionBinding(view);
  const text = instruction.trim();
  const operation = host.instruct;
  if (!binding || !instructionValid || !operation || inFlight(view)) return;
  instructionBusy = false;
  invalidDraft = undefined;
  unrecordedDraft = undefined;
  const input = {
    itemId,
    ...binding,
    text,
    requestId: crypto.randomUUID(),
  };
  // A stale result is a refresh-and-retry signal: run() reloads the view and
  // the draft is kept; it is never treated as a denial.
  void run(async () => {
    const result = await operation(input);
    if (result && 'stale' in result && result.stale === true) {
      instructionBusy = true;
      unrecordedDraft = instruction;
      return;
    }
    if (result && 'invalid' in result && result.invalid === true) {
      invalidDraft = instruction;
      return;
    }
    instruction = '';
  });
}
function locationLabel(location: EvidenceLocation) {
  switch (location.kind) {
    case 'page':
      return t(M['ingestion.page'], { page: location.page });
    case 'pages':
      return t(M['ingestion.pages'], {
        start: location.startPage,
        end: location.endPage,
      });
    case 'time':
      return t(M['ingestion.time'], {
        start: location.startMs / 1000,
        end: location.endMs / 1000,
      });
    default:
      return t(M['ingestion.source']);
  }
}
function locationUrl(evidenceId: string, location: EvidenceLocation) {
  const evidence = view?.evidence.find(
    (entry) => entry.evidence.id === evidenceId,
  );
  const url = evidenceUrl(evidence?.viewUrl);
  if (!url) return undefined;
  const base = url.split('#')[0];
  if (
    location.kind === 'page' &&
    evidence?.evidence.mediaType === 'application/pdf'
  )
    return `${base}#page=${location.page}`;
  if (
    location.kind === 'pages' &&
    evidence?.evidence.mediaType === 'application/pdf'
  )
    return `${base}#page=${location.startPage}`;
  if (
    location.kind === 'time' &&
    evidence?.evidence.mediaType.startsWith('audio/')
  )
    return `${base}#t=${location.startMs / 1000},${location.endMs / 1000}`;
  return url;
}
onMount(() => {
  void load();
});
</script>
<section data-testid="intake-review" aria-busy={pending}>
<header><h1>{t(M['ingestion.review'])}</h1><Button onclick={() => load()} disabled={pending}>{t(M['ingestion.refresh'])}</Button></header>
{#if pending}<p role="status">{t(M['ingestion.loading'])}</p>{/if}
{#if error}<p role="alert">{t(M['ingestion.error'])}</p>{/if}
{#if refreshFailed}<p role="status" data-testid="refresh-retrying">{t(M['ingestion.refreshRetrying'])}</p>{/if}
{#if view}
{#if view.availability !== 'available'}<p role="alert">{t(M[`ingestion.${view.availability}`])}</p>
{:else}
{@const extracted = view.analysis ? extractedContent(view.analysis.result.output) : []}
<h2>{view.entry.label}</h2><p>{t(M[`ingestion.${view.entry.state}`])}</p>
<div class="review-grid" class:stacked={layout === 'stacked'}><EvidenceViewer evidence={view.evidence} pages={observedPages(view)} layout={layout === 'stacked' ? 'pager' : 'stack'} bind:chosen={viewerPart} bind:page={viewerPages} /><div class="details">
{#if view.instruction}
{@const applied = view.instruction.applied}{@const current = view.instruction.current}
{#if inFlight(view) && current}<p role="status" data-testid="reinterpreting">{t(M['ingestion.reinterpreting'])}</p>{/if}
{#if view.instruction.failure === 'not_started'}<p role="alert" data-testid="instruction-failure">{t(M['ingestion.reinterpretNotStarted'])}</p>{:else if view.instruction.failure}<p role="alert" data-testid="instruction-failure">{t(M['ingestion.reinterpretFailed'])} ({view.instruction.failure})</p>{/if}
{#if applied}<p data-testid="applied-instruction">{t(M['ingestion.appliedInstruction'])}: <q>{applied.text}</q></p>{#if view.instruction.stale}<p role="status" data-testid="instruction-stale">{t(M['ingestion.instructionStale'])}</p>{/if}{/if}
{#if current && current.id !== applied?.id}<p data-testid="pending-instruction">{t(M['ingestion.pendingInstruction'])}: <q>{current.text}</q></p>{/if}
{#if view.instruction.dropped}<p role="status" data-testid="dropped-instruction">{t(M['ingestion.droppedInstruction'])}: <q>{view.instruction.dropped.text}</q></p>{/if}
{/if}
{#if instructionBusy}<p role="status" data-testid="instruction-busy">{t(M['ingestion.instructionBusy'])}</p>{:else if unrecordedDraft !== undefined && unrecordedDraft === instruction}<p role="status" data-testid="instruction-not-recorded">{t(M['ingestion.instructionNotRecorded'])}</p>{/if}
{#if host.instruct && !view.entry.item.disposition && instructionBinding(view)}
<div><Textarea aria-label={t(M['ingestion.instructions'])} aria-describedby="instruction-length" maxlength={INSTRUCTION_MAX_LENGTH} bind:value={instruction} /><p id="instruction-length" data-testid="instruction-length">{t(M['ingestion.instructionLength'], { count: instruction.length, max: INSTRUCTION_MAX_LENGTH })}</p>{#if invalidDraft !== undefined && invalidDraft === instruction}<p role="alert" data-testid="instruction-invalid">{t(M['ingestion.instructionInvalid'], { max: INSTRUCTION_MAX_LENGTH })}</p>{/if}<Button disabled={!instructionValid || inFlight(view)} onclick={instruct}>{t(M['ingestion.reinterpret'])}</Button></div>
{/if}
{#if extracted.length}
<h2>{t(M['ingestion.extracted'])}</h2>
{#each extracted as segment}
<article><pre>{segment.text}</pre>
{#if segment.confidence !== undefined}<p>{t(M['ingestion.confidence'])}: {segment.confidence}</p>{:else}<p>{t(M['ingestion.noConfidence'])}</p>{/if}
{#if segment.location}{@const url = locationUrl(segment.evidenceId,segment.location)}{#if url}<Button href={url} target="_blank" rel="noopener noreferrer">{locationLabel(segment.location)}</Button>{:else}<p>{locationLabel(segment.location)}</p>{/if}{/if}
</article>
{/each}
{/if}
{#if view.generation}
{@const generation = view.generation}
<h2>{t(M['ingestion.proposals'])}</h2><p>{generation.outcome}</p>
{#if typeof view.analysis?.result.confidence === 'number' && Number.isFinite(view.analysis.result.confidence)}<p>{t(M['ingestion.confidence'])}: {view.analysis.result.confidence}</p>{:else}<p>{t(M['ingestion.noConfidence'])}</p>{/if}
{#each generation.warnings as warning}<p>{warning}</p>{/each}
{#each generation.suggestions as suggestion,index}
<article><h3>{suggestion.handlerId}</h3><p>{suggestion.explanation}</p><pre>{JSON.stringify(suggestion.args,null,2)}</pre>
{#if suggestion.alternatives.length}<h4>{t(M['ingestion.alternatives'])}</h4><ul>{#each suggestion.alternatives as alternative}<li>{alternative}</li>{/each}</ul>{/if}
{#if suggestion.missingFields.length}<h4>{t(M['ingestion.missing'])}</h4><ul>{#each suggestion.missingFields as missing}<li>{missing}</li>{/each}</ul>{/if}
<ul>{#each suggestion.evidence as reference}{@const url = locationUrl(reference.evidenceId,reference.location)}<li>{#if url}<Button href={url} target="_blank" rel="noopener noreferrer">{locationLabel(reference.location)}</Button>{:else}{locationLabel(reference.location)}{/if}</li>{/each}</ul>
{#if !view.entry.item.disposition}
{#if suggestion.disposition === 'needs_review' && previewable(suggestion)}
{@const handler = offeredHandler(suggestion)}
{@const key = draftKey(index)}
<p>{t(M['ingestion.completeSuggestion'])}</p>
<Textarea aria-label={t(M['ingestion.suggestionArgs'])} bind:value={drafts[key]} rows={6} />
{#if handler}<CandidatePicker {host} {itemId} catalog={handler} {deny} onchoose={chooseFor(index)} />{/if}
{#if edited(index)}<p>{t(M['ingestion.reviewAgain'])}</p>{/if}
{#if invalidDrafts[key] && !parseable(drafts[key])}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
{/if}
{#if previewRejected === index}<p role="alert">{t(M['ingestion.previewRejected'])}</p>{/if}
<Button disabled={!canPreview(index)} onclick={() => preview(index)}>{t(M['ingestion.preview'])}</Button>
{/if}
</article>
{/each}
{#if !view.entry.item.disposition}{#each generation.splits as proposed (proposed.evidenceId)}<div><Textarea aria-label={`${t(M['ingestion.split'])}: ${proposed.evidenceId}`} bind:value={splits[proposed.evidenceId]} /><Button disabled={!view.analysis} onclick={() => split(proposed.evidenceId)}>{t(M['ingestion.saveSplit'])}</Button></div>{/each}{/if}
{#if invalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
{/if}
{#if view.entry.item.disposition}
{#if view.disposition?.reviewer}
<p data-testid="disposition">{t(M['ingestion.resolvedBy'], { reviewer: view.disposition.reviewer })}{#if view.disposition.reason}: {view.disposition.reason}{/if}</p>
{:else}
<p data-testid="disposition">{t(M['ingestion.resolved'])}</p>
{/if}
{:else}
{#if host.startAction && view.catalog?.some((entry) => entry.kind === 'operation')}
<fieldset class="start"><legend>{t(M['ingestion.startAs'])}</legend>
<Select aria-label={t(M['ingestion.startHandler'])} bind:value={startHandler} onchange={draftStart} disabled={pending}><option value="">{t(M['ingestion.startHandler'])}</option>{#each view.catalog as entry (`${entry.id}@${entry.version}`)}{#if entry.kind === 'operation'}<option value={`${entry.id}@${entry.version}`}>{entry.id}</option>{/if}{/each}</Select>
{#if startEntry}
<p>{startEntry.description}</p>
<Textarea aria-label={t(M['ingestion.startArgs'])} bind:value={startArgs} rows={8} />
{#if startMissing.length}<h4>{t(M['ingestion.missing'])}</h4><ul>{#each startMissing as missing}<li>{missing}</li>{/each}</ul>{/if}
<Input aria-label={t(M['ingestion.reason'])} bind:value={startReason} />
<p>{t(M['ingestion.startHelp'])}</p>
{#if startInvalid}<p role="alert">{t(M['ingestion.invalid'])}</p>{/if}
{#if startRejected}<div role="alert" data-testid="start-rejected"><p>{t(M['ingestion.startRejected'])}</p>{#if startIssues.length}<p>{t(M['ingestion.refusedFields'])}</p><ul>{#each startIssues as field (field)}<li><code>{field}</code></li>{/each}</ul>{/if}</div>{/if}
<Button disabled={pending || !view.analysis} onclick={startAction}>{t(M['ingestion.start'])}</Button>
{/if}
</fieldset>
{/if}
{#if host.resolve}
<fieldset class="resolve"><legend>{t(M['ingestion.resolveNoAction'])}</legend>
<Input aria-label={t(M['ingestion.resolveReason'])} bind:value={resolveReason} disabled={pending} />
<Button disabled={pending} onclick={resolve}>{t(M['ingestion.resolveNoAction'])}</Button>
</fieldset>
{/if}
{/if}
{#if !view.reviews.actions.length}<p>{t(M['ingestion.noReviews'])}</p>{/if}
{#each view.reviews.actions as action (`${action.review.actionId}:${action.review.revision}:${action.review.reviewVersion}`)}
<ActionReview {host} {itemId} {action} {run} {deny} ondirty={(edited) => { actionDirty[action.review.actionId] = edited; }} resolved={!!view.entry.item.disposition} currentAttemptId={action.stalePlan && view.reviews.actions.find((entry) => entry.stalePlan?.id === action.stalePlan?.id) === action ? action.attemptId : undefined} catalog={view.generation?.offered.find((entry) => entry.handler.id === action.handlerId && entry.handler.version === action.handlerVersion)?.handler} />
{/each}
{#if view.reviews.nextCursor}<Button onclick={() => load(loadedPages + 1)}>{t(M['ingestion.more'])}</Button>{/if}
</div></div>
{/if}{/if}
</section>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
section{overflow-wrap:anywhere;max-width:90rem;margin-inline:auto;padding:1rem;color:var(--smrt-color-on-surface)}header{display:flex;align-items:center;justify-content:space-between;gap:1rem}.review-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem}.review-grid.stacked{grid-template-columns:minmax(0,1fr)}.details,article{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto}article{padding-block:1rem;border-block-end:var(--smrt-hairline)}fieldset{margin-block:1rem;min-width:0;display:grid;gap:.5rem}@media(max-width:48rem){.review-grid{grid-template-columns:minmax(0,1fr)}header{flex-wrap:wrap}}
}
</style>
