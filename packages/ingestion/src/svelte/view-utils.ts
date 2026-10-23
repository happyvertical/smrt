import type { EvidenceLocation } from '../extraction-types.js';
import type {
  GeneratedSuggestion,
  ProposalCatalogEntry,
} from '../proposal-dto.js';
import type { InboxEntry, InboxState, ItemReviewView } from '../review-dto.js';

/**
 * Initial arguments for a reviewer-chosen handler: a same-handler suggestion's
 * arguments when one exists, otherwise evidence references for a single
 * original. Nothing else is invented; the handler's preview validates them.
 */
export function draftArguments(
  entry: ProposalCatalogEntry,
  suggestions: readonly GeneratedSuggestion[],
  evidenceIds: readonly string[],
): Record<string, unknown> {
  const suggestion = suggestions.find(
    (candidate) =>
      candidate.handlerId === entry.id &&
      candidate.handlerVersion === entry.version,
  );
  // Plain JSON arguments; reactive state proxies cannot be structured-cloned.
  const args: Record<string, unknown> = suggestion
    ? (JSON.parse(JSON.stringify(suggestion.args)) as Record<string, unknown>)
    : {};
  for (const [field, reference] of Object.entries(entry.references))
    if (
      reference.kind === 'evidence' &&
      !Object.hasOwn(args, field) &&
      evidenceIds.length === 1
    )
      args[field] = evidenceIds[0];
  return args;
}
/** Required schema properties the draft does not supply yet. */
export function missingArguments(
  entry: ProposalCatalogEntry,
  args: Record<string, unknown>,
): string[] {
  const required = entry.argsSchema.required;
  return Array.isArray(required)
    ? required.filter(
        (field): field is string =>
          typeof field === 'string' && !Object.hasOwn(args, field),
      )
    : [];
}
/** Only host-authorized same-origin HTTP URLs may reach original media elements. */
export function evidenceUrl(
  value?: string,
  origin?: string,
): string | undefined {
  if (!value) return undefined;
  const base =
    origin ??
    (typeof window === 'undefined' ? undefined : window.location.origin);
  if (!base)
    return value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\')
      ? value
      : undefined;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === base
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function argumentsObject(value: string): Record<string, unknown> {
  const result: unknown = JSON.parse(value);
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Invalid arguments');
  return result as Record<string, unknown>;
}
/** Required top-level handler arguments missing from a JSON draft; unparsable drafts report none. */
export function missingRequired(
  schema: Record<string, unknown>,
  draft: string,
): string[] {
  if (!Array.isArray(schema.required)) return [];
  try {
    const values = argumentsObject(draft);
    return schema.required.filter(
      (name): name is string =>
        typeof name === 'string' && !Object.hasOwn(values, name),
    );
  } catch {
    return [];
  }
}
export function pageGroups(value: string): number[][] {
  const result: unknown = JSON.parse(value);
  if (
    !Array.isArray(result) ||
    !result.length ||
    !result.every(
      (group) =>
        Array.isArray(group) &&
        group.length &&
        group.every((page) => Number.isSafeInteger(page) && page > 0),
    )
  )
    throw new Error('Invalid groups');
  return result;
}

/** Project useful extraction content; never present internal configuration/provenance JSON. */
export function extractedContent(output: Record<string, unknown>): Array<{
  evidenceId: string;
  text: string;
  location?: EvidenceLocation;
  confidence?: number;
}> {
  const content: Array<{
    evidenceId: string;
    text: string;
    location?: EvidenceLocation;
    confidence?: number;
  }> = [];
  if (!Array.isArray(output.results)) return content;
  for (const result of output.results) {
    if (
      !result ||
      typeof result !== 'object' ||
      !result.evidence ||
      typeof result.evidence.id !== 'string' ||
      !Array.isArray(result.segments)
    )
      continue;
    for (const segment of result.segments) {
      if (
        !segment ||
        typeof segment !== 'object' ||
        typeof segment.text !== 'string'
      )
        continue;
      const value = segment.location;
      let location: EvidenceLocation | undefined;
      if (value?.kind === 'source') location = { kind: 'source' };
      if (
        value?.kind === 'page' &&
        Number.isSafeInteger(value.page) &&
        value.page > 0
      )
        location = { kind: 'page', page: value.page };
      if (
        value?.kind === 'pages' &&
        Number.isSafeInteger(value.startPage) &&
        value.startPage > 0 &&
        Number.isSafeInteger(value.endPage) &&
        value.endPage >= value.startPage
      )
        location = {
          kind: 'pages',
          startPage: value.startPage,
          endPage: value.endPage,
        };
      if (
        value?.kind === 'time' &&
        Number.isFinite(value.startMs) &&
        value.startMs >= 0 &&
        Number.isFinite(value.endMs) &&
        value.endMs >= value.startMs
      )
        location = { kind: 'time', startMs: value.startMs, endMs: value.endMs };
      const confidence =
        segment.confidence?.scale === '0-1' &&
        typeof segment.confidence.value === 'number' &&
        Number.isFinite(segment.confidence.value) &&
        segment.confidence.value >= 0 &&
        segment.confidence.value <= 1
          ? segment.confidence.value
          : undefined;
      content.push({
        evidenceId: result.evidence.id,
        text: segment.text,
        ...(location ? { location } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      });
    }
  }
  return content;
}

/**
 * True while a background stage for the item is queued or running, including
 * the server-reported gap between a completed extraction and its not yet
 * appended interpretation. Presentation only: it drives polling, never access.
 */
export function reviewInFlight(view: ItemReviewView | undefined): boolean {
  return (
    view?.availability === 'available' &&
    !view.entry.item.disposition &&
    (view.entry.state === 'processing' ||
      ['queued', 'running'].includes(view.entry.item.processingState) ||
      !!view.instruction?.reinterpreting)
  );
}

/**
 * A row's triage status. `state` falls back to the listed inbox state when
 * nothing more specific is known (a row the reviewer has not opened).
 */
export type TriageStatus =
  | { kind: 'pending' }
  | { kind: 'ready' }
  | { kind: 'needs_review'; missing?: string[]; reason?: string }
  | { kind: 'approval' }
  | { kind: 'apply' }
  | { kind: 'failed'; reason?: string }
  | { kind: 'resolved' }
  | { kind: 'state'; state: InboxState };

/** Status from a listed row alone: it carries no generation, so no reasons. */
export function entryStatus(entry: InboxEntry): TriageStatus {
  if (entry.item.disposition || entry.state === 'resolved')
    return { kind: 'resolved' };
  if (
    entry.state === 'processing' ||
    ['queued', 'running'].includes(entry.item.processingState)
  )
    return { kind: 'pending' };
  if (entry.state === 'failed') return { kind: 'failed' };
  return { kind: 'state', state: entry.state };
}

/**
 * Status from a loaded review view: what the reviewer would do next and, for
 * a suggestion that needs review or a failed stage, a safe reason (missing
 * argument names, a generation outcome or a failure category; never server
 * exception text).
 */
export function viewStatus(view: ItemReviewView): TriageStatus {
  if (view.availability !== 'available') return entryStatus(view.entry);
  if (view.entry.item.disposition) return { kind: 'resolved' };
  if (reviewInFlight(view)) return { kind: 'pending' };
  const failure = view.instruction?.failure;
  if (failure) return { kind: 'failed', reason: failure };
  const states = view.reviews.actions.map((action) => action.review.state);
  if (states.includes('waiting_review')) return { kind: 'approval' };
  if (states.includes('authorized')) return { kind: 'apply' };
  if (
    ['completed', 'partially_completed', 'deferred', 'failed'].includes(
      view.entry.state,
    ) &&
    states.length
  )
    return entryStatus(view.entry);
  const generation = view.generation;
  if (generation?.outcome === 'provider_error')
    return { kind: 'failed', reason: generation.outcome };
  if (view.analysis?.result.error)
    return { kind: 'failed', reason: view.analysis.result.error };
  if (generation) {
    if (
      generation.suggestions.some(
        (suggestion) => suggestion.disposition === 'ready_for_review',
      )
    )
      return { kind: 'ready' };
    const missing = [
      ...new Set(
        generation.suggestions.flatMap(
          (suggestion) => suggestion.missingFields,
        ),
      ),
    ];
    if (missing.length) return { kind: 'needs_review', missing };
    return generation.suggestions.length
      ? { kind: 'needs_review' }
      : { kind: 'needs_review', reason: generation.outcome };
  }
  return entryStatus(view.entry);
}

/** Rows the queue is finished with: closed without action or fully completed. */
export function triageTerminal(status: TriageStatus): boolean {
  return (
    status.kind === 'resolved' ||
    (status.kind === 'state' && status.state === 'completed')
  );
}

/**
 * True when a reviewer operation left nothing for the reviewer on the item:
 * it was closed without action, or at least one action succeeded and none is
 * waiting for approval, waiting to be applied, executing, unknown or failed.
 * Stale, rejected and deferred actions do not hold the item open.
 */
export function triageSettled(view: ItemReviewView): boolean {
  if (view.availability !== 'available') return false;
  if (view.entry.item.disposition) return true;
  const states = view.reviews.actions.map((action) => action.review.state);
  return (
    states.includes('succeeded') &&
    !states.some((state) =>
      [
        'waiting_review',
        'authorized',
        'executing',
        'outcome_unknown',
        'failed',
      ].includes(state),
    )
  );
}

/**
 * Highest observed page per evidence part, from extraction locations and
 * proposed page groups. Only observed pages are navigable; a part without
 * any is shown without page navigation.
 */
export function observedPages(view: ItemReviewView): Record<string, number> {
  const pages: Record<string, number> = {};
  const note = (evidenceId: string, page: number) => {
    if (Number.isSafeInteger(page) && page > 0)
      pages[evidenceId] = Math.max(pages[evidenceId] ?? 0, page);
  };
  if (view.analysis)
    for (const segment of extractedContent(view.analysis.result.output)) {
      if (segment.location?.kind === 'page')
        note(segment.evidenceId, segment.location.page);
      if (segment.location?.kind === 'pages')
        note(segment.evidenceId, segment.location.endPage);
    }
  for (const split of view.generation?.splits ?? [])
    for (const group of split.groups)
      for (const page of group) note(split.evidenceId, page);
  return pages;
}
