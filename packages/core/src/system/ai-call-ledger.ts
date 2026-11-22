/**
 * The tracked-call ledger (#5516; ai-runs page section 6.4, "One charge per
 * call").
 *
 * A tracked call's reservation (its `call` event, E) is the call's ledger:
 * written at reservation and admission with the call's rate, the digest of a
 * per-call secret (its proof), the usage row it will bill and whether its
 * client identifies usage parts; later with the parts that arrived, what was
 * charged and when the call first ended. One pure function,
 * {@link foldCallUsage}, decides the amount from the parts, in the handle's
 * memory and on E alike; {@link applyCallUsage} is the only code that
 * charges or corrects a tracked call, in one owned transaction under the
 * chain lock.
 *
 * - Parts mode (the client declares `usageFeatures.parts`, sdk#1576): the
 *   amount is the sum of the distinct parts the producer identified, final
 *   once the last part is known and every part has counts.
 * - Single mode: the amount is fixed when the sender closes the call; a
 *   later event cannot be told from a copy or a running total and is
 *   refused as `no_part`.
 * - One hour after the call first ended ({@link AI_CALL_USAGE_WINDOW_MS})
 *   nothing changes its charge, the sender included. A sender whose
 *   reservation was pruned is refused (`reservation_gone`); the amount it
 *   held is recorded on the run row so the totals check can report it.
 * - An event that carries a call's id or proof is a claim, never ordinary
 *   usage: in the call's own process it reaches the call through the
 *   secret-keyed locator; from anywhere else it is refused
 *   (`relay_unsupported`, relay intake is #5526) and writes nothing.
 *
 * Internal: not re-exported by any entry point.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { AI_OWN_CALL_ID_TAG, insertAiUsageRow } from '../adapters/ai-usage.js';
import { isKnownDatabaseTransaction } from '../embedded-write-queue.js';
import { checkAiRunChainRunning } from './ai-run-lifecycle.js';
import {
  type AiRunClaimFence,
  AiRunNotFoundError,
  type AiRunRow,
  type AiRunStoppedError,
  AiRunTransitionError,
  type AiRunTx,
  type AiRunTxOptions,
  aiRunQuery,
  assertAiRunFence,
  dateOrNull,
  forUpdate,
  getRows,
  lockAiRunChainFenced,
  lockAiRunChainInTenant,
  num,
  text,
  withAiRunTransaction,
  writeAiRunTotals,
} from './ai-run-model.js';

const logger = createLogger({ level: 'info' });

// ---------------------------------------------------------------------------
// Constants and tag names
// ---------------------------------------------------------------------------

/**
 * W: one hour from a call's first end. Equal to the sweep's stale
 * reservation threshold (`AI_RUN_SWEEP_DEFAULTS.staleReservationMs`).
 */
export const AI_CALL_USAGE_WINDOW_MS = 60 * 60_000;

/** How long a closed call stays reachable in its own process. */
export const AI_CALL_LOCATOR_TTL_MS = 60_000;

/** The usage tag carrying a tracked call's secret (never stored). */
export const AI_CALL_PROOF_TAG = 'aiCallProof';

/** The tags that claim a call: an event with either is never ordinary. */
export const AI_CALL_CLAIM_TAGS: readonly string[] = [
  AI_OWN_CALL_ID_TAG,
  AI_CALL_PROOF_TAG,
];

/** Core's own tag names: callers' values for them are not the call's. */
export const AI_CALL_CORE_TAGS: readonly string[] = [
  AI_OWN_CALL_ID_TAG,
  AI_CALL_PROOF_TAG,
  'callId',
  'runId',
  'stepIndex',
  'stepName',
  'stepInstanceId',
  'attempt',
];

const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REFUSAL_CAP = 999_999;
const LATE_RECORD_CAP = 20;
const RUN_REFUSED_CAP = 100;
const MAX_GAPS = 32;

const KNOWN_SOURCES = new Set([
  'complete',
  'parts',
  'response',
  'event',
  'provisional',
  'fallback',
]);

// ---------------------------------------------------------------------------
// The fold (plan section 3.3)
// ---------------------------------------------------------------------------

/** How a call's amount is decided, fixed at admission. */
export type CallUsageMode = 'parts' | 'single';

/** One usage part as the producer names it (sdk#1576 R1). */
export interface UsagePartRef {
  call: string;
  index: number;
  last?: true;
  /**
   * The producer could not count this part (cost-only, cache-only,
   * malformed or inconsistent counters, sdk#1585): treated like a
   * count-less part, so it never completes the call.
   */
  uncounted?: true;
}

/** Token counts as a part or a response reports them. */
export interface TokenCounts {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

type Range = [number, number];

interface SingleCounts {
  prompt: number;
  completion: number;
  total: number;
  model?: string;
  provider?: string;
  duration?: number;
}

/** A late amount the ledger refused, kept for the totals check. */
export interface RefusedLateAmount {
  reason: string;
  tokens: number;
  cost: number | null;
  chargedTokens?: number | null;
  at: string;
}

/** What `call_usage` holds: the mode, the fold's state and refusals. */
export interface CallUsageState {
  mode: CallUsageMode;
  /** Parts mode: the producer's call id. */
  call?: string;
  counted?: Range[];
  countless?: Range[];
  last?: number;
  prompt?: number;
  completion?: number;
  total?: number;
  duration?: number;
  model?: string;
  provider?: string;
  modelAt?: number;
  /** Single mode: the last counted event the call received. */
  event?: SingleCounts;
  /** Single mode: a count-less event arrived. */
  countlessEvent?: true;
  /** Single mode: what the sender stated at closing. */
  stated?: SingleCounts & { cost?: number; counted: boolean };
  refused?: Record<string, number>;
  late?: RefusedLateAmount[];
}

/** One input to the fold. */
export type CallUsageInput =
  | {
      kind: 'part';
      part: UsagePartRef;
      usage?: TokenCounts;
      model?: string;
      provider?: string;
      duration?: number;
    }
  | {
      kind: 'parts';
      call: string;
      parts: Array<{
        index: number;
        last?: true;
        uncounted?: true;
        usage?: TokenCounts;
      }>;
      complete?: boolean;
      model?: string;
      provider?: string;
    }
  | {
      kind: 'event';
      usage?: TokenCounts;
      model?: string;
      provider?: string;
      duration?: number;
    }
  | {
      kind: 'stated';
      usage?: TokenCounts;
      estimatedCost?: number;
      model?: string;
      provider?: string;
      duration?: number;
    };

/** A new, empty state. */
export function emptyCallUsage(mode: CallUsageMode): CallUsageState {
  return { mode };
}

/**
 * A raw `part` field: the part, `undefined` when absent, `null` when it is
 * present but not `{ call: non-empty string, index: non-negative safe
 * integer, last?: true }`.
 */
export function parseUsagePart(raw: unknown): UsagePartRef | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const part = raw as Record<string, unknown>;
  if (typeof part.call !== 'string' || part.call === '') return null;
  if (
    typeof part.index !== 'number' ||
    !Number.isSafeInteger(part.index) ||
    part.index < 0
  ) {
    return null;
  }
  if (part.last !== undefined && part.last !== true) return null;
  if (part.uncounted !== undefined && part.uncounted !== true) return null;
  return {
    call: part.call,
    index: part.index,
    ...(part.last === true ? { last: true as const } : {}),
    ...(part.uncounted === true ? { uncounted: true as const } : {}),
  };
}

/** Validated counts: `undefined` when none, `null` when malformed. */
function readCounts(
  usage: unknown,
): { prompt: number; completion: number; total: number } | null | undefined {
  if (usage === undefined || usage === null) return undefined;
  if (typeof usage !== 'object' || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
    return undefined;
  };
  const values = {
    prompt: pick('promptTokens', 'inputTokens'),
    completion: pick('completionTokens', 'outputTokens'),
    total: pick('totalTokens'),
  };
  for (const value of Object.values(values)) {
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      return null;
    }
  }
  if (
    values.prompt === undefined &&
    values.completion === undefined &&
    values.total === undefined
  ) {
    return undefined;
  }
  const prompt = (values.prompt as number | undefined) ?? 0;
  const completion = (values.completion as number | undefined) ?? 0;
  const total = (values.total as number | undefined) ?? prompt + completion;
  if (!Number.isSafeInteger(total)) return null;
  return { prompt, completion, total };
}

function inRanges(ranges: Range[] | undefined, index: number): boolean {
  return (ranges ?? []).some(([lo, hi]) => index >= lo && index <= hi);
}

function addToRanges(ranges: Range[] | undefined, index: number): Range[] {
  const out = [
    ...(ranges ?? []).map((r) => [...r] as Range),
    [index, index] as Range,
  ];
  out.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of out) {
    const prev = merged[merged.length - 1];
    if (prev && range[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function removeFromRanges(ranges: Range[] | undefined, index: number): Range[] {
  const out: Range[] = [];
  for (const [lo, hi] of ranges ?? []) {
    if (index < lo || index > hi) {
      out.push([lo, hi]);
      continue;
    }
    if (lo <= index - 1) out.push([lo, index - 1]);
    if (index + 1 <= hi) out.push([index + 1, hi]);
  }
  return out;
}

function maxIndex(state: CallUsageState): number {
  let max = -1;
  for (const [, hi] of [...(state.counted ?? []), ...(state.countless ?? [])]) {
    if (hi > max) max = hi;
  }
  return max;
}

/** Separate gaps among the known indexes (a missing index 0 is one). */
function gapCount(counted: Range[], countless: Range[]): number {
  const all = [...counted, ...countless]
    .map((range) => [...range] as Range)
    .sort((a, b) => a[0] - b[0]);
  const union: Range[] = [];
  for (const range of all) {
    const prev = union[union.length - 1];
    if (prev && range[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], range[1]);
    else union.push(range);
  }
  if (union.length === 0) return 0;
  return union.length - 1 + ((union[0] as Range)[0] > 0 ? 1 : 0);
}

function clone(state: CallUsageState): CallUsageState {
  return JSON.parse(JSON.stringify(state)) as CallUsageState;
}

/** What one fold step did. */
export interface CallUsageFold {
  state: CallUsageState;
  changed: boolean;
  refused?: string;
}

function foldPart(
  state: CallUsageState,
  input: Extract<CallUsageInput, { kind: 'part' }>,
): CallUsageFold {
  if (state.mode !== 'parts')
    return { state, changed: false, refused: 'no_part' };
  const { part } = input;
  // An uncounted part's counters are not trusted: it is count-less.
  const counts = part.uncounted ? undefined : readCounts(input.usage);
  if (counts === null) return { state, changed: false, refused: 'malformed' };
  if (state.call !== undefined && part.call !== state.call) {
    return { state, changed: false, refused: 'other_call' };
  }
  if (state.last !== undefined && part.index > state.last) {
    return { state, changed: false, refused: 'beyond_last' };
  }
  if (part.last) {
    if (state.last !== undefined && state.last !== part.index) {
      return { state, changed: false, refused: 'last_conflict' };
    }
    if (maxIndex(state) > part.index) {
      return { state, changed: false, refused: 'last_conflict' };
    }
  }
  const next = clone(state);
  next.call ??= part.call;
  let changed = next.call !== state.call;
  const setLast = () => {
    if (part.last && next.last === undefined) {
      next.last = part.index;
      changed = true;
    }
  };
  const addCounts = () => {
    if (!counts) return true;
    const sum = {
      prompt: (next.prompt ?? 0) + counts.prompt,
      completion: (next.completion ?? 0) + counts.completion,
      total: (next.total ?? 0) + counts.total,
    };
    if (
      !Number.isSafeInteger(sum.prompt) ||
      !Number.isSafeInteger(sum.completion) ||
      !Number.isSafeInteger(sum.total)
    ) {
      return false;
    }
    next.prompt = sum.prompt;
    next.completion = sum.completion;
    next.total = sum.total;
    return true;
  };
  const noteModel = () => {
    if (input.model && part.index >= (next.modelAt ?? -1)) {
      next.model = input.model;
      if (input.provider) next.provider = input.provider;
      next.modelAt = part.index;
    }
    if (typeof input.duration === 'number' && Number.isFinite(input.duration)) {
      next.duration = (next.duration ?? 0) + Math.max(0, input.duration);
    }
  };
  if (inRanges(state.counted, part.index)) {
    // A second counted report, or a count-less copy: a duplicate.
    setLast();
    return { state: changed ? next : state, changed };
  }
  if (inRanges(state.countless, part.index)) {
    if (counts) {
      // A counted report for a count-less index replaces it, once.
      if (!addCounts()) return { state, changed: false, refused: 'overflow' };
      next.countless = removeFromRanges(next.countless, part.index);
      next.counted = addToRanges(next.counted, part.index);
      setLast();
      noteModel();
      return { state: next, changed: true };
    }
    setLast();
    return { state: changed ? next : state, changed };
  }
  if (counts) next.counted = addToRanges(next.counted, part.index);
  else next.countless = addToRanges(next.countless, part.index);
  if (gapCount(next.counted ?? [], next.countless ?? []) > MAX_GAPS) {
    return { state, changed: false, refused: 'gaps' };
  }
  if (!addCounts()) return { state, changed: false, refused: 'overflow' };
  setLast();
  noteModel();
  if (next.countless?.length === 0) delete next.countless;
  if (next.counted?.length === 0) delete next.counted;
  return { state: next, changed: true };
}

function singleCounts(
  counts: { prompt: number; completion: number; total: number },
  input: { model?: string; provider?: string; duration?: number },
): SingleCounts {
  return {
    ...counts,
    ...(input.model ? { model: input.model } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(typeof input.duration === 'number' && Number.isFinite(input.duration)
      ? { duration: Math.max(0, input.duration) }
      : {}),
  };
}

/** Fold one input into a state (never mutates `state`). */
export function foldCallUsage(
  state: CallUsageState,
  input: CallUsageInput,
): CallUsageFold {
  switch (input.kind) {
    case 'part':
      return foldPart(state, input);
    case 'parts': {
      if (state.mode !== 'parts') {
        return { state, changed: false, refused: 'no_part' };
      }
      let current = state;
      let changed = false;
      let refused: string | undefined;
      for (const part of input.parts ?? []) {
        const parsed = parseUsagePart({ call: input.call, ...part });
        if (!parsed) {
          refused ??= 'malformed';
          continue;
        }
        const step = foldPart(current, {
          kind: 'part',
          part: parsed,
          ...(part.usage ? { usage: part.usage } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
        });
        if (step.refused) refused ??= step.refused;
        if (step.changed) changed = true;
        current = step.state;
      }
      return { state: current, changed, ...(refused ? { refused } : {}) };
    }
    case 'event': {
      if (state.mode !== 'single') {
        return { state, changed: false, refused: 'no_part' };
      }
      const counts = readCounts(input.usage);
      if (counts === null)
        return { state, changed: false, refused: 'malformed' };
      const next = clone(state);
      if (counts) next.event = singleCounts(counts, input);
      else next.countlessEvent = true;
      return { state: next, changed: true };
    }
    case 'stated': {
      if (state.mode !== 'single') return { state, changed: false };
      const counts = readCounts(input.usage);
      if (counts === null)
        return { state, changed: false, refused: 'malformed' };
      const cost =
        typeof input.estimatedCost === 'number' &&
        Number.isFinite(input.estimatedCost) &&
        input.estimatedCost >= 0
          ? input.estimatedCost
          : undefined;
      const next = clone(state);
      next.stated = {
        ...(counts
          ? singleCounts(counts, input)
          : { prompt: 0, completion: 0, total: 0 }),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(cost !== undefined ? { cost } : {}),
        counted: Boolean(counts),
      };
      return { state: next, changed: true };
    }
  }
}

/** Whether the state holds any usage at all (a part, an event, a statement). */
export function callUsageHeld(state: CallUsageState): boolean {
  if (state.mode === 'parts') {
    return Boolean(state.counted?.length || state.countless?.length);
  }
  return Boolean(state.event || state.countlessEvent || state.stated?.counted);
}

/** Whether the parts are final: last known, every index counted. */
export function callUsageComplete(state: CallUsageState): boolean {
  if (state.mode !== 'parts' || state.last === undefined) return false;
  if (state.countless?.length) return false;
  const counted = state.counted ?? [];
  return (
    counted.length === 1 &&
    (counted[0] as Range)[0] === 0 &&
    (counted[0] as Range)[1] === state.last
  );
}

/** The amount a state charges. */
export interface CallUsageAmount {
  source:
    | 'complete'
    | 'parts'
    | 'response'
    | 'event'
    | 'provisional'
    | 'fallback';
  tokens: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  model?: string;
  provider?: string;
  duration?: number;
}

/**
 * The amount a state charges, priced from the rate the reservation recorded
 * (prompt tokens times `input` plus completion tokens times `output`, per
 * 1K; a missing split counts as zero), or a cost the single-mode sender
 * stated. No event's own cost and no rate card at delivery is an input.
 */
export function callUsageAmount(
  state: CallUsageState,
  basis: {
    reservedTokens: number;
    rate: { input: number; output: number } | null;
  },
): CallUsageAmount {
  const price = (prompt: number | null, completion: number | null) =>
    basis.rate
      ? ((prompt ?? 0) * basis.rate.input +
          (completion ?? 0) * basis.rate.output) /
        1000
      : null;
  const measured = (
    source: CallUsageAmount['source'],
    counts: { prompt: number; completion: number; total: number },
    extra: {
      model?: string;
      provider?: string;
      duration?: number;
      cost?: number;
    },
  ): CallUsageAmount => ({
    source,
    tokens: counts.total,
    promptTokens: counts.prompt,
    completionTokens: counts.completion,
    totalTokens: counts.total,
    cost:
      extra.cost !== undefined
        ? extra.cost
        : price(counts.prompt, counts.completion),
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.provider ? { provider: extra.provider } : {}),
    ...(extra.duration !== undefined ? { duration: extra.duration } : {}),
  });
  const estimate = (
    source: 'provisional' | 'fallback',
    extra: {
      model?: string;
      provider?: string;
      duration?: number;
      cost?: number;
    },
  ): CallUsageAmount => ({
    source,
    tokens: Math.max(0, Math.round(basis.reservedTokens)),
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    cost: extra.cost !== undefined ? extra.cost : price(null, null),
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.provider ? { provider: extra.provider } : {}),
    ...(extra.duration !== undefined ? { duration: extra.duration } : {}),
  });
  if (state.mode === 'parts') {
    const extra = {
      ...(state.model ? { model: state.model } : {}),
      ...(state.provider ? { provider: state.provider } : {}),
      ...(state.duration !== undefined ? { duration: state.duration } : {}),
    };
    if (state.counted?.length) {
      return measured(
        callUsageComplete(state) ? 'complete' : 'parts',
        {
          prompt: state.prompt ?? 0,
          completion: state.completion ?? 0,
          total: state.total ?? 0,
        },
        extra,
      );
    }
    return estimate(
      state.countless?.length ? 'provisional' : 'fallback',
      extra,
    );
  }
  const stated = state.stated;
  const statedCost = stated?.cost !== undefined ? { cost: stated.cost } : {};
  if (stated?.counted) {
    // A provider or model the response did not state comes from the last
    // event the call received.
    return measured('response', stated, {
      ...(state.event?.model ? { model: state.event.model } : {}),
      ...(state.event?.provider ? { provider: state.event.provider } : {}),
      ...stated,
      ...statedCost,
    });
  }
  const durationOf = stated?.duration ?? state.event?.duration;
  if (state.event) {
    return measured('event', state.event, {
      ...state.event,
      ...(stated?.model ? { model: stated.model } : {}),
      ...(stated?.provider ? { provider: stated.provider } : {}),
      ...(durationOf !== undefined ? { duration: durationOf } : {}),
      ...statedCost,
    });
  }
  return estimate(state.countlessEvent ? 'provisional' : 'fallback', {
    ...(stated?.model ? { model: stated.model } : {}),
    ...(stated?.provider ? { provider: stated.provider } : {}),
    ...(durationOf !== undefined ? { duration: durationOf } : {}),
    ...statedCost,
  });
}

function countRefusal(state: CallUsageState, reason: string, n = 1): void {
  state.refused ??= {};
  state.refused[reason] = Math.min(
    REFUSAL_CAP,
    (state.refused[reason] ?? 0) + n,
  );
}

function recordLate(state: CallUsageState, late: RefusedLateAmount): void {
  state.late = [...(state.late ?? []), late].slice(-LATE_RECORD_CAP);
}

// ---------------------------------------------------------------------------
// The secret, the proof and claims
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 32 random bytes as 43 base64url characters. */
export function mintCallSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** The hex SHA-256 of a secret: what the reservation stores. */
export async function callProofDigest(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

let warnedClaimTags = false;

/**
 * A copy of `tags` without core's claim tags (`aiCallId`, `aiCallProof`), or
 * the same object when it has none. Warned once per process.
 */
export function withoutClaimTags<T extends Record<string, unknown> | undefined>(
  tags: T,
): T {
  if (!tags || typeof tags !== 'object') return tags;
  if (!AI_CALL_CLAIM_TAGS.some((name) => name in tags)) return tags;
  const copy = { ...tags } as Record<string, unknown>;
  for (const name of AI_CALL_CLAIM_TAGS) delete copy[name];
  if (!warnedClaimTags) {
    warnedClaimTags = true;
    logger.warn(
      `[smrt] usage tags ${AI_CALL_CLAIM_TAGS.join(', ')} are core's own; the values a caller supplied were removed`,
    );
  }
  return copy as T;
}

/** A copy of `tags` without `aiCallProof`. */
export function withoutProof(
  tags: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!tags || !(AI_CALL_PROOF_TAG in tags)) return tags;
  const { [AI_CALL_PROOF_TAG]: _proof, ...rest } = tags;
  return rest;
}

/** A call reachable in the process that made it, by its secret. */
export interface CallLocator {
  callId: string;
  deliver(raw: Record<string, unknown>): Promise<void>;
}

// Module-local on purpose: another module graph (another worker) has none.
const locators = new Map<string, CallLocator>();

/** Make a call reachable by its secret until {@link closeCallLocator}. */
export function registerCallLocator(
  secret: string,
  locator: CallLocator,
): void {
  locators.set(secret, locator);
}

/** Forget a call's locator after `ttlMs`. */
export function closeCallLocator(secret: string, ttlMs: number): void {
  const remove = () => {
    locators.delete(secret);
  };
  if (ttlMs <= 0) {
    remove();
    return;
  }
  const timer = setTimeout(remove, ttlMs) as unknown as { unref?: () => void };
  timer.unref?.();
}

/** How a received event relates to tracked calls. */
export type AiUsageClaim =
  | { kind: 'ordinary' }
  | { kind: 'bound'; locator: CallLocator }
  | {
      kind: 'refused';
      reason: 'no_proof' | 'no_call_id' | 'malformed' | 'relay_unsupported';
      callId?: string;
      proof?: string;
    };

/**
 * Classify a raw usage event before normalization. An event with neither
 * claim tag is ordinary usage. One with a well-formed pair whose secret
 * names a call open in this process is bound to it; every other claim is
 * refused, the same way whatever it names.
 */
export function classifyAiUsageClaim(raw: unknown): AiUsageClaim {
  const tags = (raw as { tags?: unknown } | null)?.tags;
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    return { kind: 'ordinary' };
  }
  const record = tags as Record<string, unknown>;
  const present = (name: string) =>
    record[name] !== undefined && record[name] !== null;
  const hasId = present(AI_OWN_CALL_ID_TAG);
  const hasProof = present(AI_CALL_PROOF_TAG);
  if (!hasId && !hasProof) return { kind: 'ordinary' };
  const id =
    typeof record[AI_OWN_CALL_ID_TAG] === 'string' &&
    record[AI_OWN_CALL_ID_TAG] !== ''
      ? (record[AI_OWN_CALL_ID_TAG] as string)
      : undefined;
  const proof =
    typeof record[AI_CALL_PROOF_TAG] === 'string'
      ? (record[AI_CALL_PROOF_TAG] as string)
      : undefined;
  if (!hasProof) {
    return {
      kind: 'refused',
      reason: 'no_proof',
      ...(id ? { callId: id } : {}),
    };
  }
  if (!id) return { kind: 'refused', reason: 'no_call_id' };
  if (!proof || !PROOF_PATTERN.test(proof)) {
    return { kind: 'refused', reason: 'malformed', callId: id };
  }
  const locator = locators.get(proof);
  if (locator && locator.callId === id) return { kind: 'bound', locator };
  return { kind: 'refused', reason: 'relay_unsupported', callId: id, proof };
}

const refusalLogged = new Map<string, number>();

function logRefusal(reason: string, message: string): void {
  const now = Date.now();
  const last = refusalLogged.get(reason);
  if (last !== undefined && now - last < 60_000) return;
  refusalLogged.set(reason, now);
  logger.warn(message);
}

/**
 * Record a refused claim: logged (rate-limited per reason) and, when the
 * receiving pipeline has a database and the call is found by its id in the
 * event's own tenant, counted on its reservation. A `relay_unsupported`
 * delivery is counted only when its proof matches the reservation's digest,
 * and then its amount is kept for the totals check. Never throws.
 */
export async function recordRefusedClaim(
  db: DatabaseInterface | null | undefined,
  claim: Extract<AiUsageClaim, { kind: 'refused' }>,
  tenantId: string | null | undefined,
  raw: unknown,
): Promise<void> {
  logRefusal(
    claim.reason,
    `[smrt] AI usage event refused (${claim.reason})${
      claim.callId ? ` for call ${claim.callId}` : ''
    }: an event that names a tracked call is applied only by that call; nothing was recorded`,
  );
  if (!db || !claim.callId) return;
  try {
    const digest =
      claim.reason === 'relay_unsupported' && claim.proof
        ? await callProofDigest(claim.proof)
        : null;
    await withAiRunTransaction(db, async (tx) => {
      const tenant = tenantId ?? null;
      const rows = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT e.id, e.call_proof, e.call_usage, e.call_rate, e.charged_tokens
             FROM _smrt_ai_run_events e
             JOIN _smrt_ai_runs r ON r.id = e.run_id
            WHERE e.call_id = $1 AND e.type = 'call'
              AND ${tenant === null ? 'r.tenant_id IS NULL' : 'r.tenant_id = $2'}${forUpdate(tx)}`,
          claim.callId,
          ...(tenant === null ? [] : [tenant]),
        ),
      );
      const row = rows[0];
      if (!row) return;
      if (
        claim.reason === 'relay_unsupported' &&
        text(row.call_proof) !== digest
      ) {
        return;
      }
      const state = parseCallUsage(row.call_usage) ?? emptyCallUsage('single');
      countRefusal(state, claim.reason);
      if (claim.reason === 'relay_unsupported') {
        const counts = readCounts((raw as { usage?: unknown } | null)?.usage);
        if (counts) {
          const rate = parseRate(row.call_rate);
          recordLate(state, {
            reason: claim.reason,
            tokens: counts.total,
            cost: rate
              ? (counts.prompt * rate.input + counts.completion * rate.output) /
                1000
              : null,
            chargedTokens:
              row.charged_tokens === null || row.charged_tokens === undefined
                ? null
                : num(row.charged_tokens),
            at: tx.now.toISOString(),
          });
        }
      }
      await aiRunQuery(
        tx.db,
        'UPDATE _smrt_ai_run_events SET call_usage = $2 WHERE id = $1',
        String(row.id),
        JSON.stringify(state),
      );
    });
  } catch (error) {
    logger.warn(
      `[smrt] could not count a refused AI usage event for call ${claim.callId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const senderRecords = new WeakSet<object>();

/** Mark a handler record produced by the sender's own closing write. */
export function markSenderRecord(event: SmrtAiUsageEvent): SmrtAiUsageEvent {
  senderRecords.add(event);
  return event;
}

/** Whether a normalized event is the sender's own record. */
export function isSenderRecord(event: unknown): boolean {
  return (
    typeof event === 'object' && event !== null && senderRecords.has(event)
  );
}

/**
 * Turn a raw event bound to a call into a fold input, checking the raw shape
 * first (no normalization default takes part in a decision).
 */
export function callUsageInputFromRaw(
  raw: Record<string, unknown>,
  mode: CallUsageMode,
): { input?: CallUsageInput; refused?: string } {
  if (typeof raw.provider !== 'string' || raw.provider === '') {
    return { refused: 'malformed' };
  }
  if (typeof raw.model !== 'string' || raw.model === '') {
    return { refused: 'malformed' };
  }
  const timestamp = raw.timestamp;
  const validTime =
    timestamp instanceof Date
      ? !Number.isNaN(timestamp.getTime())
      : (typeof timestamp === 'string' || typeof timestamp === 'number') &&
        !Number.isNaN(new Date(timestamp).getTime());
  if (!validTime) return { refused: 'malformed' };
  if (
    raw.tags !== undefined &&
    (typeof raw.tags !== 'object' || raw.tags === null)
  ) {
    return { refused: 'malformed' };
  }
  const counts = readCounts(raw.usage);
  if (counts === null) return { refused: 'malformed' };
  const usage = counts
    ? {
        promptTokens: counts.prompt,
        completionTokens: counts.completion,
        totalTokens: counts.total,
      }
    : undefined;
  const duration =
    typeof raw.duration === 'number' && Number.isFinite(raw.duration)
      ? raw.duration
      : undefined;
  const common = {
    ...(usage ? { usage } : {}),
    model: raw.model,
    provider: raw.provider,
    ...(duration !== undefined ? { duration } : {}),
  };
  if (mode === 'single') return { input: { kind: 'event', ...common } };
  const part = parseUsagePart(raw.part);
  if (part === undefined) return { refused: 'no_part' };
  if (part === null) return { refused: 'malformed' };
  return { input: { kind: 'part', part, ...common } };
}

// ---------------------------------------------------------------------------
// Admission written with the reservation (plan section 3.1)
// ---------------------------------------------------------------------------

/** The ledger columns admission writes, given the transaction's clock. */
export interface CallAdmission {
  callProof: string;
  callRow: string;
  callUsage: string;
}

const admissions = new WeakMap<object, (now: Date) => CallAdmission>();

/**
 * Have the reservation insert of `request` (an ordinary tracked call) write
 * the call's proof, billed row and mode in the same transaction.
 */
export function admitWithReservation<T extends object>(
  request: T,
  admission: (now: Date) => CallAdmission,
): T {
  admissions.set(request, admission);
  return request;
}

/** The admission a reservation request carries, if any. */
export function reservationAdmission(
  request: object,
): ((now: Date) => CallAdmission) | undefined {
  return admissions.get(request);
}

/**
 * Admit a held share (a fusion seat's part of a joint reservation) just
 * before it is sent, in one transaction: the claim fence first; with
 * `checkRunning` the chain locked and `running` (a stopped chain releases
 * the share and the stop is thrown); the run looked up in the context's
 * tenant; then the guarded write of the call's proof, billed row and mode,
 * which finds the share only while it is still `reserved` and not yet
 * admitted. No row: {@link AiRunTransitionError}, nothing sent, no proof.
 */
export async function admitHeldCall(
  db: DatabaseInterface,
  runId: string,
  callId: string,
  options: AiRunTxOptions & {
    checkRunning: boolean;
    fence?: AiRunClaimFence;
    expectedTenant?: string | null;
  },
  admission: (now: Date) => CallAdmission,
): Promise<void> {
  const stopped = await withAiRunTransaction(
    db,
    async (tx): Promise<AiRunStoppedError | null> => {
      let status: AiRunRow['status'];
      if (options.checkRunning) {
        const chain = await lockAiRunChainFenced(
          tx,
          runId,
          options.fence,
          options.expectedTenant,
        );
        const stop = await checkAiRunChainRunning(tx, chain);
        const run = chain[chain.length - 1] as AiRunRow;
        status = run.status;
        if (stop) {
          const released = getRows(
            await aiRunQuery(
              tx.db,
              `UPDATE _smrt_ai_run_events
                  SET call_state = 'released', status = 'cancelled',
                      ended_at = COALESCE(ended_at, $3)
                WHERE run_id = $1 AND call_id = $2 AND type = 'call'
                  AND call_state = 'reserved'
                RETURNING reserved_tokens, reserved_cost`,
              runId,
              callId,
              tx.now.toISOString(),
            ),
          )[0];
          if (released) {
            await chargeChainBy(
              tx,
              chain,
              { firstCharge: false, tokens: 0, cost: 0 },
              {
                tokens: num(released.reserved_tokens),
                cost: num(released.reserved_cost),
              },
            );
          }
          return stop;
        }
      } else {
        await assertAiRunFence(
          tx,
          runId,
          options.fence,
          options.expectedTenant,
        );
        const tenant = options.expectedTenant;
        const run = getRows(
          await aiRunQuery(
            tx.db,
            `SELECT status FROM _smrt_ai_runs WHERE id = $1${
              tenant === undefined
                ? ''
                : tenant === null
                  ? ' AND tenant_id IS NULL'
                  : ' AND tenant_id = $2'
            }`,
            runId,
            ...(tenant === undefined || tenant === null ? [] : [tenant]),
          ),
        )[0];
        if (!run) throw new AiRunNotFoundError(runId);
        status = String(run.status) as AiRunRow['status'];
      }
      const values = admission(tx.now);
      const admitted = getRows(
        await aiRunQuery(
          tx.db,
          `UPDATE _smrt_ai_run_events
              SET call_proof = $3, call_row = $4, call_usage = $5
            WHERE run_id = $1 AND call_id = $2 AND type = 'call'
              AND call_state = 'reserved' AND call_proof IS NULL
            RETURNING id`,
          runId,
          callId,
          values.callProof,
          values.callRow,
          values.callUsage,
        ),
      );
      if (!admitted[0]) {
        throw new AiRunTransitionError(
          `AI call ${callId} of run ${runId} is no longer reserved`,
          runId,
          status,
          status,
        );
      }
      return null;
    },
    options,
  );
  if (stopped) throw stopped;
}

const observedParts = new WeakMap<object, CallUsageInput>();

/**
 * Attach a response's `usageParts` (sdk#1576 R2) to the usage the sender
 * observed, when it is well formed.
 */
export function withObservedParts<T extends object>(
  observed: T,
  usageParts: unknown,
): T {
  const value = usageParts as {
    call?: unknown;
    parts?: unknown;
    complete?: unknown;
  } | null;
  if (
    value &&
    typeof value === 'object' &&
    typeof value.call === 'string' &&
    value.call !== '' &&
    Array.isArray(value.parts)
  ) {
    observedParts.set(observed, {
      kind: 'parts',
      call: value.call,
      parts: value.parts as Array<{
        index: number;
        last?: true;
        usage?: TokenCounts;
      }>,
      ...(typeof value.complete === 'boolean'
        ? { complete: value.complete }
        : {}),
    });
  }
  return observed;
}

/** The response's parts attached to observed usage, if any. */
export function observedUsageParts(
  observed: object | undefined,
): CallUsageInput | undefined {
  return observed ? observedParts.get(observed) : undefined;
}

/** What a tracked client tells the call it starts (never public). */
export interface CallInternals {
  mode: CallUsageMode;
  /** Tag sources 1 and 2: the sink attribution's and the client's own. */
  attributionTags?: Record<string, string>;
}

const internalsOf = new WeakMap<object, CallInternals>();

/** Attach the internals of a call to its request. */
export function withCallInternals<T extends object>(
  request: T,
  internals: CallInternals,
): T {
  internalsOf.set(request, internals);
  return request;
}

/** The internals attached to a call's request, if any. */
export function callInternals(request: object): CallInternals | undefined {
  return internalsOf.get(request);
}

/**
 * Whether a database handle is a transaction: a framework or caller-declared
 * one (`isKnownDatabaseTransaction`) or an adapter's own transaction handle
 * (it has `commit` and `rollback`). A bound handle an adapter hands to a
 * `transaction()` callback with neither mark is not recognized (limit L2).
 */
export function isTransactionHandle(db: DatabaseInterface): boolean {
  const handle = db as Partial<{ commit: unknown; rollback: unknown }>;
  return (
    isKnownDatabaseTransaction(db) ||
    (typeof handle.commit === 'function' &&
      typeof handle.rollback === 'function')
  );
}

// ---------------------------------------------------------------------------
// The reservation row
// ---------------------------------------------------------------------------

/** The billed row's template, fixed at admission (`call_row`). */
export interface CallRowTemplate {
  provider: string;
  model: string;
  operation: string;
  className?: string;
  tags: Record<string, string>;
  /** The admission instant: the usage row's `created_at`. */
  createdAt: string;
}

interface LedgerRow {
  id: string;
  callState: string | null;
  status: string | null;
  reservedTokens: number;
  reservedCost: number;
  callProof: string | null;
  callRow: CallRowTemplate | null;
  callRate: { input: number; output: number } | null;
  callUsage: CallUsageState | null;
  endedAt: Date | null;
  usageSource: string | null;
  chargedTokens: number | null;
  chargedCost: number | null;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/** `call_usage` parsed; null when absent or unreadable. */
export function parseCallUsage(value: unknown): CallUsageState | null {
  const parsed = parseJson(value) as CallUsageState | null;
  return parsed && (parsed.mode === 'parts' || parsed.mode === 'single')
    ? parsed
    : null;
}

function parseRate(value: unknown): { input: number; output: number } | null {
  const parsed = parseJson(value) as {
    input?: unknown;
    output?: unknown;
  } | null;
  if (!parsed) return null;
  const input = Number(parsed.input);
  const output = Number(parsed.output);
  return Number.isFinite(input) && Number.isFinite(output)
    ? { input, output }
    : null;
}

const LEDGER_COLUMNS = `id, call_state, status, reserved_tokens, reserved_cost,
  call_proof, call_row, call_rate, call_usage, ended_at, usage_source,
  charged_tokens, charged_cost`;

function toLedgerRow(row: Record<string, unknown>): LedgerRow {
  const nullable = (value: unknown) =>
    value === null || value === undefined ? null : num(value);
  return {
    id: String(row.id),
    callState: text(row.call_state),
    status: text(row.status),
    reservedTokens: num(row.reserved_tokens),
    reservedCost: num(row.reserved_cost),
    callProof: text(row.call_proof),
    callRow: parseJson(row.call_row) as CallRowTemplate | null,
    callRate: parseRate(row.call_rate),
    callUsage: parseCallUsage(row.call_usage),
    endedAt: dateOrNull(row.ended_at),
    usageSource: text(row.usage_source),
    chargedTokens: nullable(row.charged_tokens),
    chargedCost: nullable(row.charged_cost),
  };
}

/** Read a call's reservation under the chain lock (`FOR UPDATE` on PostgreSQL). */
async function readLedgerRow(
  tx: AiRunTx,
  runId: string,
  callId: string,
): Promise<LedgerRow | null> {
  const row = getRows(
    await aiRunQuery(
      tx.db,
      `SELECT ${LEDGER_COLUMNS} FROM _smrt_ai_run_events
        WHERE run_id = $1 AND call_id = $2 AND type = 'call'${forUpdate(tx)}`,
      runId,
      callId,
    ),
  )[0];
  return row ? toLedgerRow(row) : null;
}

// ---------------------------------------------------------------------------
// Charging the chain and writing the row
// ---------------------------------------------------------------------------

/** Move a chain's totals by one call's change, after checking every sum. */
async function chargeChainBy(
  tx: AiRunTx,
  chain: AiRunRow[],
  change: { firstCharge: boolean; tokens: number; cost: number | null },
  returned: { tokens: number; cost: number } | null,
): Promise<void> {
  const caller = chain[chain.length - 1] as AiRunRow;
  for (const run of chain) {
    if (returned) {
      run.reservedCalls -= 1;
      run.reservedTokens -= returned.tokens;
      run.reservedCost -= returned.cost;
    }
    if (change.firstCharge) {
      run.inclusiveCalls += 1;
      if (change.cost === null) run.inclusiveUncostedCalls += 1;
      if (run === caller) {
        run.calls += 1;
        if (change.cost === null) run.uncostedCalls += 1;
      }
    }
    run.inclusiveTokens += change.tokens;
    run.inclusiveCost += change.cost ?? 0;
    if (run === caller) {
      run.tokens += change.tokens;
      run.costUsed += change.cost ?? 0;
    }
    await writeAiRunTotals(tx, run);
  }
}

/** Whether a change keeps every token total on the chain a safe integer. */
function chainCanTake(chain: AiRunRow[], tokens: number): boolean {
  const caller = chain[chain.length - 1] as AiRunRow;
  return chain.every(
    (run) =>
      Number.isSafeInteger(run.inclusiveTokens + tokens) &&
      (run !== caller || Number.isSafeInteger(run.tokens + tokens)),
  );
}

/** The usage row the ledger writes, as an event. */
function rowEvent(
  template: CallRowTemplate,
  amount: CallUsageAmount,
  tenantId: string | null,
): SmrtAiUsageEvent {
  return {
    provider: amount.provider ?? template.provider,
    model: amount.model ?? template.model,
    operation: template.operation,
    usage:
      amount.totalTokens === null
        ? undefined
        : {
            promptTokens: amount.promptTokens ?? undefined,
            completionTokens: amount.completionTokens ?? undefined,
            totalTokens: amount.totalTokens,
          },
    ...(amount.cost !== null ? { estimatedCost: amount.cost } : {}),
    duration: Math.max(0, Math.round(amount.duration ?? 0)),
    timestamp: new Date(template.createdAt),
    tags: { ...template.tags },
    ...(template.className ? { className: template.className } : {}),
    tenantId,
  } as SmrtAiUsageEvent;
}

/**
 * Write the call's usage row: inserted (or rebuilt, when retention outside
 * this version removed it) or updated in place when the row under the id is
 * this call's own (its run, its run's tenant). A row of another run or
 * tenant is never overwritten: `foreign`.
 */
async function writeCallRow(
  tx: AiRunTx,
  input: { runId: string; callId: string; tenantId: string | null },
  template: CallRowTemplate,
  amount: CallUsageAmount,
): Promise<'written' | 'foreign'> {
  const existing = getRows(
    await aiRunQuery(
      tx.db,
      `SELECT id, run_id, tenant_id FROM _smrt_ai_usage WHERE id = $1${forUpdate(tx)}`,
      input.callId,
    ),
  )[0];
  const event = rowEvent(template, amount, input.tenantId);
  if (!existing) {
    await insertAiUsageRow(tx.db, event, {
      id: input.callId,
      runId: input.runId,
    });
    return 'written';
  }
  if (
    text(existing.run_id) !== input.runId ||
    (text(existing.tenant_id) ?? null) !== input.tenantId
  ) {
    return 'foreign';
  }
  await aiRunQuery(
    tx.db,
    `UPDATE _smrt_ai_usage
        SET provider = $2, model = $3, prompt_tokens = $4, completion_tokens = $5,
            total_tokens = $6, estimated_cost = $7, duration_ms = $8
      WHERE id = $1`,
    input.callId,
    event.provider,
    event.model,
    amount.promptTokens,
    amount.completionTokens,
    amount.totalTokens,
    amount.cost,
    event.duration,
  );
  return 'written';
}

/** The handler record of a call, from what the ledger holds. */
function senderRecord(
  template: CallRowTemplate,
  amount: CallUsageAmount,
  tenantId: string | null,
): SmrtAiUsageEvent {
  return markSenderRecord(rowEvent(template, amount, tenantId));
}

/** Amounts charged so far, as an amount. */
function chargedAmount(row: LedgerRow, state: CallUsageState): CallUsageAmount {
  const current = callUsageAmount(state, {
    reservedTokens: row.reservedTokens,
    rate: row.callRate,
  });
  return {
    ...current,
    tokens: row.chargedTokens ?? current.tokens,
    cost: row.chargedCost,
  };
}

// ---------------------------------------------------------------------------
// The one merge (plan section 3.4)
// ---------------------------------------------------------------------------

/** Who writes. */
export type CallLedgerCaller = 'sender' | 'sweep' | 'delivery';

/** Input of {@link applyCallUsage}. */
export interface ApplyCallUsageRequest {
  runId: string;
  callId: string;
  expectedTenant?: string | null;
  caller: CallLedgerCaller;
  inputs: CallUsageInput[];
  /** Refusals the handle counted in memory, recorded with its write. */
  refusedCounts?: Record<string, number>;
  /** The sender's status (`ok`, `failed`, ...). */
  status?: string;
  /** The sender's mode, for a refusal after its reservation is gone. */
  mode?: CallUsageMode;
  /**
   * The sender failed: release a reservation that holds no usage instead of
   * charging it (usage parked on it is settled).
   */
  releaseIfEmpty?: boolean;
}

/** What {@link applyCallUsage} did. */
export type ApplyCallUsageResult =
  | {
      outcome:
        | 'charged'
        | 'merged'
        | 'unchanged'
        | 'parked'
        | 'abandoned'
        | 'released';
      /** The sender's handler record (closing writes only). */
      record?: SmrtAiUsageEvent;
      /** `charged`: the state the reservation left. */
      from?: string;
    }
  | { outcome: 'refused'; reason: string };

async function writeState(
  tx: AiRunTx,
  row: LedgerRow,
  state: CallUsageState,
): Promise<void> {
  await aiRunQuery(
    tx.db,
    'UPDATE _smrt_ai_run_events SET call_usage = $2 WHERE id = $1',
    row.id,
    JSON.stringify(state),
  );
}

/** Record a late amount refused after its reservation was pruned. */
async function recordOnRun(
  tx: AiRunTx,
  run: AiRunRow,
  entry: { callId: string } & RefusedLateAmount,
): Promise<void> {
  const current = getRows(
    await aiRunQuery(
      tx.db,
      'SELECT refused_usage FROM _smrt_ai_runs WHERE id = $1',
      run.id,
    ),
  )[0];
  const list = (parseJson(current?.refused_usage) as unknown[] | null) ?? [];
  const next = [...(Array.isArray(list) ? list : []), entry].slice(
    -RUN_REFUSED_CAP,
  );
  await aiRunQuery(
    tx.db,
    'UPDATE _smrt_ai_runs SET refused_usage = $2 WHERE id = $1',
    run.id,
    JSON.stringify(next),
  );
}

function foldAll(
  state: CallUsageState,
  inputs: CallUsageInput[],
  refusedCounts: Record<string, number> | undefined,
): { state: CallUsageState; changed: boolean } {
  let current = clone(state);
  let changed = false;
  for (const input of inputs) {
    const step = foldCallUsage(current, input);
    current = step.state;
    if (step.changed) changed = true;
    if (step.refused) {
      current = clone(current);
      countRefusal(current, step.refused);
      changed = true;
    }
  }
  for (const [reason, n] of Object.entries(refusedCounts ?? {})) {
    if (n > 0) {
      countRefusal(current, reason, n);
      changed = true;
    }
  }
  return { state: current, changed };
}

/**
 * Apply usage to a call whose chain the caller already locked, inside its
 * transaction. See {@link applyCallUsage}.
 */
export async function applyCallUsageLocked(
  tx: AiRunTx,
  chain: AiRunRow[],
  request: ApplyCallUsageRequest,
): Promise<ApplyCallUsageResult> {
  const run = chain[chain.length - 1] as AiRunRow;
  const tenantId = run.tenantId ?? null;
  const row = await readLedgerRow(tx, request.runId, request.callId);
  const now = tx.now;
  if (!row) {
    if (request.caller === 'sender') {
      const held = foldAll(
        emptyCallUsage(request.mode ?? 'single'),
        request.inputs,
        undefined,
      ).state;
      const amount = callUsageAmount(held, { reservedTokens: 0, rate: null });
      const entry = {
        callId: request.callId,
        reason: 'reservation_gone',
        tokens: amount.tokens,
        cost: amount.cost,
        at: now.toISOString(),
      };
      await recordOnRun(tx, run, entry);
      logger.warn(
        `[smrt] AI run ${request.runId} call ${request.callId} (tenant ${tenantId ?? 'global'}): the reservation was pruned before its sender closed it; its ${amount.tokens} tokens were not charged and are reported by checkAiRunTotals`,
      );
      return { outcome: 'refused', reason: 'reservation_gone' };
    }
    return { outcome: 'refused', reason: 'unknown' };
  }
  if (!row.callProof || !row.callRow) {
    return { outcome: 'refused', reason: 'legacy' };
  }
  const template = row.callRow;
  const base = row.callUsage ?? emptyCallUsage('single');
  if (request.caller === 'delivery' && base.mode === 'single') {
    const state = clone(base);
    countRefusal(state, 'no_part', Math.max(1, request.inputs.length));
    await writeState(tx, row, state);
    return { outcome: 'refused', reason: 'no_part' };
  }
  const folded = foldAll(base, request.inputs, request.refusedCounts);
  let state = folded.state;
  const windowOpen =
    !row.endedAt ||
    now.getTime() < row.endedAt.getTime() + AI_CALL_USAGE_WINDOW_MS;
  const charged = row.chargedTokens !== null;
  const basis = { reservedTokens: row.reservedTokens, rate: row.callRate };
  const status = request.caller === 'sender' ? (request.status ?? 'ok') : null;

  const firstCharge = async (
    from: string,
    to: 'settled' | 'settled_late',
  ): Promise<ApplyCallUsageResult> => {
    const amount = callUsageAmount(state, basis);
    if (!chainCanTake(chain, amount.tokens)) {
      const refused = clone(state);
      countRefusal(refused, 'overflow');
      await writeState(tx, row, refused);
      return { outcome: 'refused', reason: 'overflow' };
    }
    const written = await writeCallRow(
      tx,
      { runId: request.runId, callId: request.callId, tenantId },
      template,
      amount,
    );
    if (written === 'foreign') {
      // The id is held by another run's or tenant's row: main's rule, the
      // call is released and charged nothing.
      logger.warn(
        `[smrt] AI run ${request.runId} call ${request.callId}: its usage row id is held by another run's row; released it without a charge`,
      );
      await aiRunQuery(
        tx.db,
        `UPDATE _smrt_ai_run_events
            SET call_state = 'released', ended_at = COALESCE(ended_at, $2), call_usage = $3
          WHERE id = $1`,
        row.id,
        now.toISOString(),
        JSON.stringify(state),
      );
      if (from === 'reserved') {
        await chargeChainBy(
          tx,
          chain,
          { firstCharge: false, tokens: 0, cost: 0 },
          {
            tokens: row.reservedTokens,
            cost: row.reservedCost,
          },
        );
      }
      return { outcome: 'refused', reason: 'row_taken' };
    }
    const moved = getRows(
      await aiRunQuery(
        tx.db,
        `UPDATE _smrt_ai_run_events
            SET call_state = $2, status = COALESCE($3, status),
                ended_at = COALESCE(ended_at, $4), usage_source = $5,
                charged_tokens = $6, charged_cost = $7, call_usage = $8
          WHERE id = $1 AND call_state = $9
          RETURNING id`,
        row.id,
        to,
        status ?? (request.caller === 'sweep' ? 'ok' : null),
        now.toISOString(),
        amount.source,
        amount.tokens,
        amount.cost,
        JSON.stringify(state),
        from,
      ),
    );
    if (!moved[0])
      throw new Error(`AI call ${request.callId} moved during its charge`);
    await chargeChainBy(
      tx,
      chain,
      { firstCharge: true, tokens: amount.tokens, cost: amount.cost },
      from === 'reserved'
        ? { tokens: row.reservedTokens, cost: row.reservedCost }
        : null,
    );
    return {
      outcome: 'charged',
      from,
      ...(request.caller === 'sender'
        ? { record: senderRecord(template, amount, tenantId) }
        : {}),
    };
  };

  if (row.callState === 'reserved') {
    if (request.caller === 'delivery') {
      if (folded.changed) await writeState(tx, row, state);
      return { outcome: folded.changed ? 'parked' : 'unchanged' };
    }
    const releasing =
      !callUsageHeld(state) &&
      (request.caller === 'sweep' || request.releaseIfEmpty === true);
    if (releasing) {
      const to = request.caller === 'sweep' ? 'abandoned' : 'released';
      const moved = getRows(
        await aiRunQuery(
          tx.db,
          `UPDATE _smrt_ai_run_events
              SET call_state = $2, status = $3,
                  ended_at = COALESCE(ended_at, $4), call_usage = $5
            WHERE id = $1 AND call_state = 'reserved'
            RETURNING id`,
          row.id,
          to,
          request.caller === 'sweep' ? 'abandoned' : (status ?? 'failed'),
          now.toISOString(),
          JSON.stringify(state),
        ),
      );
      if (!moved[0]) return { outcome: 'unchanged' };
      await chargeChainBy(
        tx,
        chain,
        { firstCharge: false, tokens: 0, cost: 0 },
        {
          tokens: row.reservedTokens,
          cost: row.reservedCost,
        },
      );
      return { outcome: to === 'abandoned' ? 'abandoned' : 'released' };
    }
    return firstCharge('reserved', 'settled');
  }

  if (
    (row.callState === 'released' || row.callState === 'abandoned') &&
    !charged
  ) {
    if (request.caller === 'sweep') return { outcome: 'unchanged' };
    if (request.releaseIfEmpty && !callUsageHeld(state)) {
      if (folded.changed) await writeState(tx, row, state);
      return { outcome: 'unchanged' };
    }
    if (request.caller === 'delivery') {
      if (!windowOpen) {
        const refused = clone(base);
        countRefusal(refused, 'expired', Math.max(1, request.inputs.length));
        await writeState(tx, row, refused);
        return { outcome: 'refused', reason: 'expired' };
      }
      if (!callUsageHeld(state)) {
        if (folded.changed) await writeState(tx, row, state);
        return { outcome: 'unchanged' };
      }
    }
    // A call not yet charged takes its sender's first charge for as long
    // as its reservation exists.
    return firstCharge(row.callState, 'settled_late');
  }

  if (
    charged &&
    (row.callState === 'settled' || row.callState === 'settled_late')
  ) {
    if (request.caller === 'sweep') return { outcome: 'unchanged' };
    if (!windowOpen) {
      const refused = clone(base);
      if (request.caller === 'sender') {
        const amount = callUsageAmount(state, basis);
        countRefusal(refused, 'late_sender');
        const late = {
          reason: 'late_sender',
          tokens: amount.tokens,
          cost: amount.cost,
          chargedTokens: row.chargedTokens,
          at: now.toISOString(),
        };
        recordLate(refused, late);
        await aiRunQuery(
          tx.db,
          `UPDATE _smrt_ai_run_events SET call_usage = $2, status = COALESCE($3, status)
            WHERE id = $1`,
          row.id,
          JSON.stringify(refused),
          status,
        );
        logger.warn(
          `[smrt] AI run ${request.runId} call ${request.callId} (tenant ${tenantId ?? 'global'}): its sender closed it more than an hour after it first ended; ${amount.tokens} tokens against ${row.chargedTokens} charged were not applied and are reported by checkAiRunTotals`,
        );
        return {
          outcome: 'refused',
          reason: 'late_sender',
        };
      }
      countRefusal(refused, 'expired', Math.max(1, request.inputs.length));
      await writeState(tx, row, refused);
      return { outcome: 'refused', reason: 'expired' };
    }
    // Merge: a complete or single-mode amount never changes.
    const frozen = row.usageSource === 'complete' || state.mode === 'single';
    const next = frozen
      ? chargedAmount(row, state)
      : callUsageAmount(state, basis);
    const deltaTokens = next.tokens - (row.chargedTokens ?? 0);
    const deltaCost =
      next.cost === null || row.chargedCost === null
        ? 0
        : next.cost - row.chargedCost;
    const source =
      row.usageSource !== null && !KNOWN_SOURCES.has(row.usageSource)
        ? row.usageSource
        : frozen
          ? row.usageSource
          : next.source;
    const statusChanged = status !== null && status !== row.status;
    if (
      !folded.changed &&
      deltaTokens === 0 &&
      deltaCost === 0 &&
      source === row.usageSource &&
      !statusChanged
    ) {
      return {
        outcome: 'unchanged',
        ...(request.caller === 'sender'
          ? {
              record: senderRecord(
                template,
                chargedAmount(row, state),
                tenantId,
              ),
            }
          : {}),
      };
    }
    if (!chainCanTake(chain, deltaTokens)) {
      state = clone(base);
      countRefusal(state, 'overflow');
      await writeState(tx, row, state);
      return { outcome: 'refused', reason: 'overflow' };
    }
    await aiRunQuery(
      tx.db,
      `UPDATE _smrt_ai_run_events
          SET call_usage = $2, usage_source = $3, status = COALESCE($4, status),
              charged_tokens = $5, charged_cost = $6
        WHERE id = $1`,
      row.id,
      JSON.stringify(state),
      source,
      status,
      next.tokens,
      next.cost === null ? row.chargedCost : next.cost,
    );
    const written = await writeCallRow(
      tx,
      { runId: request.runId, callId: request.callId, tenantId },
      template,
      next,
    );
    if (written === 'foreign') {
      logger.warn(
        `[smrt] AI run ${request.runId} call ${request.callId}: its usage row id is held by another run's row; the row was left as it is`,
      );
    }
    if (deltaTokens !== 0 || deltaCost !== 0) {
      await chargeChainBy(
        tx,
        chain,
        {
          firstCharge: false,
          tokens: deltaTokens,
          cost: next.cost === null ? null : deltaCost,
        },
        null,
      );
    }
    return {
      outcome: 'merged',
      ...(request.caller === 'sender'
        ? { record: senderRecord(template, next, tenantId) }
        : {}),
    };
  }
  return { outcome: 'refused', reason: 'unknown' };
}

/**
 * The only code that charges or corrects a tracked call: one owned
 * transaction, the chain locked root first, then the reservation (`FOR
 * UPDATE` on PostgreSQL), then the usage row.
 *
 * | Caller | Moves `reserved` | First charge | Merge over a charge |
 * |---|---|---|---|
 * | sender (handle, queued close) | yes | while E exists | until ended + W |
 * | sweep | yes | yes (parked parts) | no |
 * | delivery (a late part in the call's process) | no (parks) | released or abandoned, within W | until ended + W |
 */
export async function applyCallUsage(
  db: DatabaseInterface,
  request: ApplyCallUsageRequest,
  options: AiRunTxOptions = {},
): Promise<ApplyCallUsageResult> {
  try {
    return await withAiRunTransaction(
      db,
      async (tx) => {
        const chain = await lockAiRunChainInTenant(
          tx,
          request.runId,
          request.expectedTenant,
        );
        return applyCallUsageLocked(tx, chain, request);
      },
      options,
    );
  } catch (error) {
    if (!(error instanceof AiRunNotFoundError)) throw error;
    if (request.caller === 'sender') {
      logger.warn(
        `[smrt] AI run ${request.runId} no longer exists: call ${request.callId} was not charged (reservation_gone)`,
      );
      return { outcome: 'refused', reason: 'reservation_gone' };
    }
    return { outcome: 'refused', reason: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// The sender's queued closes (plan section 3.7)
// ---------------------------------------------------------------------------

interface QueuedClose {
  runId: string;
  callId: string;
  write: (options: AiRunTxOptions) => Promise<void>;
  settling?: Promise<boolean>;
  warnedAt?: number;
}

const queuedByUrl = new Map<string, QueuedClose[]>();
const queuedByHandle = new WeakMap<object, QueuedClose[]>();

function queueFor(
  db: DatabaseInterface,
  create: boolean,
): QueuedClose[] | undefined {
  const url =
    typeof db.url === 'string' && db.url && db.url !== ':memory:'
      ? db.url
      : null;
  if (url) {
    let list = queuedByUrl.get(url);
    if (!list && create) {
      list = [];
      queuedByUrl.set(url, list);
    }
    return list;
  }
  let list = queuedByHandle.get(db);
  if (!list && create) {
    list = [];
    queuedByHandle.set(db, list);
  }
  return list;
}

/** Keep a sender's closing write that failed every retry. */
export function queueCallClose(
  db: DatabaseInterface,
  entry: Omit<QueuedClose, 'settling' | 'warnedAt'>,
): void {
  queueFor(db, true)?.push({ ...entry });
}

/** Closing writes waiting for this database. */
export function queuedCallCloses(db: DatabaseInterface): number {
  return queueFor(db, false)?.length ?? 0;
}

async function attemptClose(
  list: QueuedClose[],
  entry: QueuedClose,
  options: AiRunTxOptions,
): Promise<boolean> {
  try {
    await entry.write(options);
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    return true;
  } catch (error) {
    const at = Date.now();
    if (entry.warnedAt === undefined || at - entry.warnedAt >= 5 * 60_000) {
      entry.warnedAt = at;
      logger.warn(
        `[smrt] AI run ${entry.runId} close of call ${entry.callId} is still pending: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return false;
  } finally {
    entry.settling = undefined;
  }
}

/**
 * Write the queued closes of this database, oldest first. With `runId`,
 * that run's are written in line and a failure throws, so the run's next
 * reservation waits; another run's oldest gets one attempt in the
 * background.
 */
export async function flushCallCloses(
  db: DatabaseInterface,
  options: { runId?: string } & AiRunTxOptions = {},
): Promise<void> {
  const list = queueFor(db, false);
  if (!list || list.length === 0) return;
  const held = new Set<string>();
  for (const entry of [...list]) {
    if (!list.includes(entry) || held.has(entry.runId)) continue;
    if (options.runId && entry.runId !== options.runId) {
      held.add(entry.runId);
      if (!entry.settling) {
        entry.settling = attemptClose(list, entry, { ...options, attempts: 1 });
        entry.settling.catch(() => undefined);
      }
      continue;
    }
    const settling = entry.settling ?? attemptClose(list, entry, options);
    entry.settling = settling;
    if (!(await settling)) held.add(entry.runId);
  }
  if (options.runId && list.some((entry) => entry.runId === options.runId)) {
    throw new Error(
      `AI run ${options.runId} has a settlement that could not be written yet; its next call waits for it`,
    );
  }
}

// ---------------------------------------------------------------------------
// Totals: what the ledger refused
// ---------------------------------------------------------------------------

/** A late amount a run's ledger refused, as the totals check reports it. */
export interface RunRefusedAmount extends RefusedLateAmount {
  callId: string;
  tenantId: string | null;
}

/**
 * The late amounts refused for a run: from its calls' reservations while
 * they exist, and from the run row once a reservation was pruned.
 */
export function refusedAmountsOf(
  tenantId: string | null,
  calls: Array<{ callId: string; callUsage: unknown }>,
  runRefused: unknown,
): RunRefusedAmount[] {
  const out: RunRefusedAmount[] = [];
  for (const call of calls) {
    for (const late of parseCallUsage(call.callUsage)?.late ?? []) {
      out.push({ ...late, callId: call.callId, tenantId });
    }
  }
  const list = parseJson(runRefused);
  for (const entry of Array.isArray(list) ? list : []) {
    const record = entry as RefusedLateAmount & { callId?: unknown };
    if (typeof record.callId !== 'string') continue;
    out.push({
      reason: String(record.reason),
      tokens: num(record.tokens),
      cost:
        record.cost === null || record.cost === undefined
          ? null
          : num(record.cost),
      at: String(record.at),
      callId: record.callId,
      tenantId,
    });
  }
  return out;
}
