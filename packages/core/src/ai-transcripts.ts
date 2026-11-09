/**
 * Opt-in AI call transcripts (#4780): the capture side.
 *
 * While the app enables `inference.transcripts` (app level only: smrt.config
 * < `config({ inference })` < `SMRT_INFERENCE_TRANSCRIPTS`; never instance
 * options, resolvers or tenant settings), every call through a client wrapped
 * by {@link withAiTranscripts} gets a `callId` usage tag, which
 * `_smrt_ai_usage` lifts to `call_id`. A sampled share of successful calls,
 * and every forced call, stores its redacted, size-capped content in
 * `_smrt_ai_transcripts` (`system/ai-transcripts.ts`).
 *
 * - Forced (stored at any sample rate): a failed call, a call whose usage
 *   events carry `substitutions` (fallback or degradation, #4752), a call
 *   whose fusion run is `degraded` or `failed` (#4753), and a call passing
 *   `transcript: true`. A call passing `transcript: false` is never stored.
 * - Redaction: the host redactor ({@link setTranscriptRedactor}) runs first,
 *   then the built-in one always runs: it masks the client's own API key and
 *   the calling object's `sensitive` field values, and strips the secret
 *   token shapes smrt-config's export redactor knows (`sk-…`, `AKIA…`,
 *   `Bearer …`, PEM blocks, URL credentials, …).
 * - Size: request + response + tool events are capped at `maxBytes` (default
 *   64 KiB) by a head-and-tail cut of the largest parts; `truncated` marks it.
 *
 * Disabled (the default), nothing here runs: clients are returned unwrapped,
 * no `callId` is minted and call options are byte-identical (the #4750
 * parity contract).
 *
 * Browser-safe: no Node-only imports.
 */

import { createLogger } from '@happyvertical/logger';
import { redactSecretValues } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { resolveAiUsageTenantId } from './adapters/ai-usage-recorder.js';
import {
  assertInferenceTranscriptsConfig,
  getInferenceConfig,
  type InferenceRunStatus,
  type InferenceTranscriptPromptConfig,
} from './inference.js';
import { recordAiTranscript } from './system/ai-transcripts.js';

const logger = createLogger({ level: 'info' });

/** The usage tag that carries a call's id (lifted to `call_id`). */
export const AI_CALL_ID_TAG = 'callId';
/** Default capture rate for successful calls. */
export const DEFAULT_TRANSCRIPT_SAMPLE = 0.1;
/** Default per-row byte cap. */
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 65_536;
/**
 * Values shorter than this are masked only as a whole token (not inside a
 * longer word), so a short secret is still masked without garbling text.
 */
export const MIN_SENSITIVE_VALUE_LENGTH = 4;

// ============================================================================
// Config
// ============================================================================

/** `inference.transcripts` with defaults applied. */
export interface ResolvedAiTranscriptConfig {
  enabled: boolean;
  sample: number;
  maxBytes: number;
  prompts: Record<string, InferenceTranscriptPromptConfig>;
}

/**
 * The process-level transcript config (#4780). Throws on an invalid block,
 * so a typo never silently stores (or silently drops) content.
 */
export function resolveAiTranscriptConfig(): ResolvedAiTranscriptConfig {
  const transcripts = getInferenceConfig()?.transcripts;
  assertInferenceTranscriptsConfig(transcripts);
  return {
    enabled: transcripts?.enabled === true,
    sample: transcripts?.sample ?? DEFAULT_TRANSCRIPT_SAMPLE,
    maxBytes: transcripts?.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES,
    prompts: { ...(transcripts?.prompts ?? {}) },
  };
}

/** Whether the app stores transcripts. */
export function aiTranscriptsEnabled(): boolean {
  return resolveAiTranscriptConfig().enabled;
}

/** The success capture rate for a prompt key. */
export function aiTranscriptSampleRate(
  config: ResolvedAiTranscriptConfig,
  promptKey: string | undefined,
): number {
  const override =
    promptKey !== undefined && Object.hasOwn(config.prompts, promptKey)
      ? config.prompts[promptKey]?.sample
      : undefined;
  return override ?? config.sample;
}

/** Why a finished call is stored, or `null` when it is not. */
export type AiTranscriptCaptureReason =
  | 'requested'
  | 'failed'
  | 'substituted'
  | 'degraded-run'
  | 'sampled';

/**
 * The capture decision for one finished call. `random` is drawn only for a
 * call that is neither forced nor opted out.
 */
export function aiTranscriptCaptureReason(
  input: {
    directive?: boolean;
    failed: boolean;
    substituted: boolean;
    degradedRun: boolean;
    sample: number;
  },
  random: () => number = Math.random,
): AiTranscriptCaptureReason | null {
  if (input.directive === false) return null;
  if (input.directive === true) return 'requested';
  if (input.failed) return 'failed';
  if (input.substituted) return 'substituted';
  if (input.degradedRun) return 'degraded-run';
  return input.sample > 0 && random() < input.sample ? 'sampled' : null;
}

// ============================================================================
// Redaction
// ============================================================================

/** One message of a transcript part, as the redactor sees it. */
export interface AiTranscriptMessage {
  /** `system`, `user`, `assistant`, `tool`, `tool-call`, `tool-result`, `reasoning`, `error`, `decision`. */
  role: string;
  /** Text, content parts, or a structured value (tool arguments, a decision). */
  content: unknown;
  name?: string;
  toolCallId?: string;
}

/** What a redactor knows about the call. */
export interface AiTranscriptRedactionContext {
  part: 'request' | 'response' | 'tools';
  callId: string;
  tenantId: string | null;
  operation: string;
  className?: string;
  promptKey?: string;
  provider?: string;
  model?: string;
}

/** Host redaction hook; returns the messages to store. */
export type AiTranscriptRedactor = (
  messages: AiTranscriptMessage[],
  context: AiTranscriptRedactionContext,
) => AiTranscriptMessage[] | Promise<AiTranscriptMessage[]>;

declare global {
  // eslint-disable-next-line no-var
  var __smrtAiTranscriptRedactor: AiTranscriptRedactor | undefined;
}

/**
 * Register the host redactor, run before every transcript write and before
 * the built-in redactor (which always runs). Pass `undefined` to clear.
 * Stored on `globalThis` so every loaded copy of core shares it.
 */
export function setTranscriptRedactor(
  redactor: AiTranscriptRedactor | undefined,
): void {
  globalThis.__smrtAiTranscriptRedactor = redactor;
}

/** The registered host redactor, if any. */
export function getTranscriptRedactor(): AiTranscriptRedactor | undefined {
  return globalThis.__smrtAiTranscriptRedactor;
}

/** Field names whose values are masked wherever they appear (tool args, …). */
const SECRET_FIELD =
  /^(?:api[-_]?key|authorization|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|private[-_]?key|x[-_]api[-_]key)$/i;

/** Exact values the built-in redactor masks for one call. */
export interface AiTranscriptRedactionValues {
  /** Credentials the client carries (its API key): masked as `[REDACTED]`. */
  secrets?: readonly string[];
  /** The calling object's `sensitive` field values: `[REDACTED:<field>]`. */
  sensitive?: ReadonlyArray<{ field: string; value: string }>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One exact value to mask: its pattern, its mask and the raw value. */
type Replacement = [pattern: RegExp, mask: string, raw: string];

function redactString(
  value: string,
  replacements: ReadonlyArray<Replacement>,
): string {
  let out = value;
  for (const [pattern, mask] of replacements) out = out.replace(pattern, mask);
  return redactSecretValues(out);
}

/**
 * A string holding a JSON object or array (serialized tool arguments, a JSON
 * answer): parsed so credential-named fields inside it are masked too.
 */
function parseEmbeddedJson(value: string): unknown {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function redactValue(
  value: unknown,
  replacements: ReadonlyArray<Replacement>,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    const embedded = parseEmbeddedJson(value);
    if (embedded !== undefined) {
      // Field-aware pass over the parsed tree (leaves, numbers, keys), then
      // the serialized values (an object-valued sensitive field echoed
      // verbatim) over the re-serialized JSON. Only those: a scalar mask on
      // the text would cut into other numbers and break the JSON.
      let out = JSON.stringify(redactValue(embedded, replacements, seen));
      for (const [pattern, mask, raw] of replacements) {
        if (raw.startsWith('{') || raw.startsWith('[')) {
          out = out.replace(pattern, JSON.stringify(mask));
        }
      }
      return out;
    }
    return redactString(value, replacements);
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    // A sensitive or secret value that is a number in structured content
    // (`{"pin":4821}`) is masked when it equals the value exactly.
    const raw = String(value);
    const match = replacements.find(([, , exact]) => exact === raw);
    return match ? match[1] : value;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, replacements, seen));
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    // Binary content (an image buffer) is never stored.
    return '[binary]';
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    // Keys are text too: a secret used as a key is masked like any string.
    out[redactString(key, replacements)] =
      SECRET_FIELD.test(key) && item !== null && item !== undefined
        ? '[REDACTED]'
        : redactValue(item, replacements, seen);
  }
  return out;
}

/**
 * The built-in redactor: masks the given secrets and sensitive values
 * exactly, masks values under credential-named keys, and strips secret token
 * shapes (smrt-config `redactSecretValues()`). Always runs, after the host's.
 */
export function redactAiTranscriptMessages(
  messages: AiTranscriptMessage[],
  values: AiTranscriptRedactionValues = {},
): AiTranscriptMessage[] {
  const replacements: Replacement[] = [];
  const add = (raw: string, mask: string) => {
    const value = raw.trim();
    if (value === '') return;
    // Long values are masked wherever they occur; short ones only as a whole
    // token, so a 3-digit code is masked without rewriting every number.
    const pattern =
      value.length >= MIN_SENSITIVE_VALUE_LENGTH
        ? escapeRegExp(value)
        : `(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`;
    replacements.push([new RegExp(pattern, 'gu'), mask, value]);
  };
  for (const secret of values.secrets ?? []) add(secret, '[REDACTED]');
  // Longest first, so a value containing another is masked whole.
  for (const { field, value } of [...(values.sensitive ?? [])].sort(
    (a, b) => b.value.length - a.value.length,
  )) {
    add(value, `[REDACTED:${field}]`);
  }
  const seen = new WeakSet<object>();
  return messages.map(
    (message) =>
      redactValue(message, replacements, seen) as AiTranscriptMessage,
  );
}

// ============================================================================
// Size cap
// ============================================================================

const encoder = new TextEncoder();

function byteLength(value: string | null): number {
  return value === null ? 0 : encoder.encode(value).length;
}

/** A payload cut to fit: valid JSON with the original's head and tail. */
function truncatedEnvelope(value: string, budget: number): string {
  const originalBytes = byteLength(value);
  let keep = Math.max(0, Math.floor(budget / 2));
  for (;;) {
    const envelope = JSON.stringify({
      truncated: true,
      originalBytes,
      head: value.slice(0, keep),
      tail: keep > 0 ? value.slice(-keep) : '',
    });
    if (byteLength(envelope) <= budget || keep === 0) return envelope;
    keep = Math.floor(keep * 0.85);
  }
}

/** The stored payloads after the cap. */
export interface FittedAiTranscript {
  request: string | null;
  response: string | null;
  toolEvents: string | null;
  truncated: boolean;
  bytes: number;
}

/**
 * Fit request + response + tool events into `maxBytes`. Parts that fit their
 * fair share stay whole; larger ones become `{ truncated, originalBytes,
 * head, tail }` envelopes (still JSON) sized to the remaining budget.
 */
export function fitAiTranscript(
  parts: {
    request: string | null;
    response: string | null;
    toolEvents: string | null;
  },
  maxBytes: number,
): FittedAiTranscript {
  const entries = (['request', 'response', 'toolEvents'] as const).map(
    (name) => ({ name, value: parts[name], size: byteLength(parts[name]) }),
  );
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxBytes) {
    return { ...parts, truncated: false, bytes: total };
  }
  const out: FittedAiTranscript = {
    request: parts.request,
    response: parts.response,
    toolEvents: parts.toolEvents,
    truncated: true,
    bytes: 0,
  };
  const present = entries
    .filter((entry) => entry.value !== null)
    .sort((a, b) => a.size - b.size);
  let remaining = maxBytes;
  present.forEach((entry, index) => {
    const share = Math.floor(remaining / (present.length - index));
    let stored = entry.value as string;
    if (entry.size > share) stored = truncatedEnvelope(stored, share);
    out[entry.name] = stored;
    remaining -= byteLength(stored);
  });
  out.bytes =
    byteLength(out.request) +
    byteLength(out.response) +
    byteLength(out.toolEvents);
  return out;
}

// ============================================================================
// In-flight calls
// ============================================================================

interface CaptureState {
  callId: string;
  runIds: Set<string>;
  substituted: boolean;
  degradedRun: boolean;
  provider?: string;
  model?: string;
}

interface CaptureRegistry {
  calls: Map<string, CaptureState>;
  runs: Map<string, string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __smrtAiTranscriptCaptures: CaptureRegistry | undefined;
}

/** Shared by every core copy, like the other process-wide slots. */
function registry(): CaptureRegistry {
  globalThis.__smrtAiTranscriptCaptures ??= {
    calls: new Map(),
    runs: new Map(),
  };
  return globalThis.__smrtAiTranscriptCaptures;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function hasSubstitutions(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.length > 0 : true;
  } catch {
    return true;
  }
}

/**
 * Feed one raw usage event (an SDK `onUsage` event or a core-recorded row)
 * to the in-flight call it names through its `callId` tag: substitutions
 * force capture, `runId` links the call to its fusion run, provider and
 * model fill the transcript row. Synchronous and never throws; usage
 * pipelines call it first, before any enabled/persist check.
 */
export function observeAiTranscriptUsage(event: unknown): void {
  try {
    const raw = (event ?? {}) as Record<string, unknown>;
    const tags = (raw.tags ?? {}) as Record<string, unknown>;
    const callId = text(tags[AI_CALL_ID_TAG]);
    if (!callId) return;
    const { calls, runs } = registry();
    const state = calls.get(callId);
    if (!state) return;
    const runId = text(tags.runId);
    if (runId) {
      state.runIds.add(runId);
      runs.set(runId, callId);
    }
    if (hasSubstitutions(tags.substitutions)) state.substituted = true;
    // A fusion's seats each report a model: the first seat's fills the row
    // unless an event of the entry call itself (no `seat` tag) names one.
    const provider = text(raw.provider) ?? text(raw.type);
    const model = text(raw.model);
    if (provider && (!state.provider || !tags.seat)) state.provider = provider;
    if (model && (!state.model || !tags.seat)) state.model = model;
  } catch {
    // Observation must never break usage handling.
  }
}

/**
 * A fusion run finished (#4753): a `degraded` or `failed` run forces capture
 * of the call that ran it. Called by core's executor context `recordRun()`.
 */
export function noteAiTranscriptRun(
  runId: string,
  status: InferenceRunStatus,
): void {
  const { calls, runs } = registry();
  const callId = runs.get(runId);
  const state = callId ? calls.get(callId) : undefined;
  if (!state) return;
  state.runIds.add(runId);
  if (status !== 'ok') state.degradedRun = true;
}

function beginCapture(callId: string): CaptureState | undefined {
  const { calls } = registry();
  if (calls.has(callId)) return undefined; // an outer capture owns this call
  const state: CaptureState = {
    callId,
    runIds: new Set(),
    substituted: false,
    degradedRun: false,
  };
  calls.set(callId, state);
  return state;
}

function endCapture(state: CaptureState): void {
  const { calls, runs } = registry();
  calls.delete(state.callId);
  for (const runId of state.runIds) {
    if (runs.get(runId) === state.callId) runs.delete(runId);
  }
}

/** A fresh call id. */
export function newAiCallId(): string {
  return crypto.randomUUID();
}

// ============================================================================
// Capture
// ============================================================================

/** Where and for whom a wrapped client stores transcripts. */
export interface AiTranscriptContext {
  /**
   * Database for `_smrt_ai_transcripts` (or a function read per call);
   * without one nothing is stored.
   */
  db?: DatabaseInterface | null | (() => DatabaseInterface | null | undefined);
  /** `class_name` of the row. */
  className?: string;
  /**
   * The row's tenant, resolved per call. Default: the ambient tenant
   * (`setAiUsageTenantResolver()`), else global.
   */
  tenantId?: () => string | null | undefined;
  /** Provider/model when no usage event names them. */
  provider?: string;
  model?: string;
  /** Exact credential values to mask (the client's API key). */
  secrets?: () => readonly string[];
  /** The calling object's `sensitive` field values to mask. */
  sensitive?: () => ReadonlyArray<{ field: string; value: string }>;
  /** Default `transcript` directive for calls without their own. */
  transcript?: boolean;
}

/** What a captured call sent and got. */
interface CallRecord {
  operation: string;
  request: AiTranscriptMessage[];
  options: Record<string, unknown>;
  response: AiTranscriptMessage[];
  toolEvents: AiTranscriptMessage[];
  finishReason?: string;
  error?: unknown;
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

/** Non-content call options worth keeping beside the messages. */
function optionSummary(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'model',
    'temperature',
    'maxTokens',
    'topP',
    'responseFormat',
    'stop',
  ]) {
    if (options[key] !== undefined) out[key] = options[key];
  }
  if (Array.isArray(options.tools)) {
    out.tools = options.tools.map(
      (tool) =>
        (tool as { function?: { name?: unknown }; name?: unknown })?.function
          ?.name ??
        (tool as { name?: unknown })?.name ??
        'tool',
    );
  }
  return out;
}

function toolEventsFrom(messages: unknown[]): AiTranscriptMessage[] {
  const events: AiTranscriptMessage[] = [];
  for (const message of messages) {
    const record = (message ?? {}) as Record<string, unknown>;
    if (Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) events.push(toolCallEvent(call));
    }
    if (record.role === 'tool') {
      events.push({
        role: 'tool-result',
        content: record.content,
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.tool_call_id === 'string'
          ? { toolCallId: record.tool_call_id }
          : {}),
      });
    }
  }
  return events;
}

function toolCallEvent(call: unknown): AiTranscriptMessage {
  const record = (call ?? {}) as {
    id?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  return {
    role: 'tool-call',
    content: record.function?.arguments ?? null,
    ...(typeof record.function?.name === 'string'
      ? { name: record.function.name }
      : {}),
    ...(typeof record.id === 'string' ? { toolCallId: record.id } : {}),
  };
}

function requestMessages(
  method: string,
  input: unknown,
  options: Record<string, unknown>,
): AiTranscriptMessage[] {
  if (method === 'chat' || method === 'stream') {
    return Array.isArray(input)
      ? input.map((message) => ({ ...(message as AiTranscriptMessage) }))
      : [{ role: 'user', content: input }];
  }
  const messages: AiTranscriptMessage[] = [];
  if (typeof options.systemPrompt === 'string') {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  if (Array.isArray(options.history)) {
    for (const message of options.history) {
      messages.push({ ...(message as AiTranscriptMessage) });
    }
  }
  messages.push({
    role: typeof options.role === 'string' ? options.role : 'user',
    content: input,
  });
  return messages;
}

function responseFrom(
  method: string,
  value: unknown,
): Pick<CallRecord, 'response' | 'toolEvents' | 'finishReason'> {
  if (typeof value === 'string') {
    return {
      response: [{ role: 'assistant', content: value }],
      toolEvents: [],
    };
  }
  const record = (value ?? {}) as Record<string, unknown>;
  if (method === 'decision') {
    return {
      response: [{ role: 'decision', content: record.answers ?? record }],
      toolEvents: [],
    };
  }
  const response: AiTranscriptMessage[] = [
    { role: 'assistant', content: record.content ?? null },
  ];
  if (typeof record.reasoning === 'string' && record.reasoning !== '') {
    response.push({ role: 'reasoning', content: record.reasoning });
  }
  return {
    response,
    toolEvents: Array.isArray(record.toolCalls)
      ? record.toolCalls.map(toolCallEvent)
      : [],
    ...(typeof record.finishReason === 'string'
      ? { finishReason: record.finishReason }
      : {}),
  };
}

function errorMessage(error: unknown): AiTranscriptMessage {
  const record = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  const name = [record.name, record.code]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(':');
  return {
    role: 'error',
    content:
      typeof record.message === 'string' ? record.message : String(error),
    ...(name ? { name } : {}),
  };
}

async function redactPart(
  messages: AiTranscriptMessage[],
  context: AiTranscriptRedactionContext,
  values: AiTranscriptRedactionValues,
): Promise<AiTranscriptMessage[]> {
  const host = getTranscriptRedactor();
  const hosted = host ? await host(messages, context) : messages;
  return redactAiTranscriptMessages(
    Array.isArray(hosted) ? hosted : [],
    values,
  );
}

/** Store one finished call if the capture decision says so; never throws. */
async function finishCapture(
  state: CaptureState,
  context: AiTranscriptContext,
  config: ResolvedAiTranscriptConfig,
  directive: boolean | undefined,
  usageTags: Record<string, string>,
  call: CallRecord,
): Promise<void> {
  try {
    const promptKey = text(usageTags.promptKey);
    const reason = aiTranscriptCaptureReason({
      directive,
      failed: call.error !== undefined,
      substituted:
        state.substituted || hasSubstitutions(usageTags.substitutions),
      degradedRun: state.degradedRun,
      sample: aiTranscriptSampleRate(config, promptKey),
    });
    if (!reason) return;
    const db = typeof context.db === 'function' ? context.db() : context.db;
    if (!db) {
      warnOnce(
        `[smrt] AI transcript for ${context.className ?? 'a raw client'} not stored: no database`,
      );
      return;
    }
    const tenantId =
      (context.tenantId ? context.tenantId() : resolveAiUsageTenantId()) ??
      null;
    const provider = state.provider ?? context.provider;
    const model =
      state.model ?? text(call.options.model) ?? context.model ?? undefined;
    // The wrapper knows the method it captured; a usage event's operation
    // label is the provider's (an executor's seats may differ).
    const operation = call.operation;
    const base = {
      callId: state.callId,
      tenantId,
      operation,
      ...(context.className ? { className: context.className } : {}),
      ...(promptKey ? { promptKey } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
    const values: AiTranscriptRedactionValues = {
      secrets: context.secrets?.() ?? [],
      sensitive: context.sensitive?.() ?? [],
    };
    const response = [
      ...call.response,
      ...(call.error !== undefined ? [errorMessage(call.error)] : []),
    ];
    const toolEvents = [...toolEventsFrom(call.request), ...call.toolEvents];
    const [request, redactedResponse, redactedTools] = await Promise.all([
      redactPart(call.request, { ...base, part: 'request' }, values),
      redactPart(response, { ...base, part: 'response' }, values),
      toolEvents.length > 0
        ? redactPart(toolEvents, { ...base, part: 'tools' }, values)
        : Promise.resolve([]),
    ]);
    const fitted = fitAiTranscript(
      {
        request: JSON.stringify({
          messages: request,
          options: redactAiTranscriptMessages(
            [{ role: 'options', content: optionSummary(call.options) }],
            values,
          )[0]?.content,
        }),
        response: JSON.stringify({
          messages: redactedResponse,
          ...(call.finishReason ? { finishReason: call.finishReason } : {}),
          capture: reason,
        }),
        toolEvents:
          redactedTools.length > 0 ? JSON.stringify(redactedTools) : null,
      },
      config.maxBytes,
    );
    const runId = text(usageTags.runId) ?? [...state.runIds][0];
    await recordAiTranscript(db, {
      ...base,
      runId: runId ?? null,
      templateHash: text(usageTags.templateHash) ?? null,
      request: fitted.request,
      response: fitted.response,
      toolEvents: fitted.toolEvents,
      truncated: fitted.truncated,
      bytes: fitted.bytes,
    });
  } catch (error) {
    warnOnce(
      `[smrt] AI transcript write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    endCapture(state);
  }
}

/** Options for {@link captureAiTranscriptCall}. */
export interface CaptureAiTranscriptCallOptions {
  /** Operation label (`decision`, …). */
  operation: string;
  request: AiTranscriptMessage[];
  /** Call options kept beside the request (model, temperature, …). */
  options?: Record<string, unknown>;
  /** Per-call directive; falls back to the context's. */
  transcript?: boolean;
  /** The call's usage tags (prompt key, template hash, run id). */
  usageTags?: Record<string, string>;
}

/**
 * Run `invoke(callId)` as one captured call for a site that is not a
 * message/chat client (the typed-decision route). Disabled, `invoke` runs
 * with `undefined` and nothing is recorded.
 */
export async function captureAiTranscriptCall<T>(
  context: AiTranscriptContext,
  call: CaptureAiTranscriptCallOptions,
  invoke: (callId: string | undefined) => Promise<T>,
): Promise<T> {
  const config = resolveAiTranscriptConfig();
  if (!config.enabled) return invoke(undefined);
  const usageTags = { ...(call.usageTags ?? {}) };
  const callId = text(usageTags[AI_CALL_ID_TAG]) ?? newAiCallId();
  usageTags[AI_CALL_ID_TAG] = callId;
  const state = beginCapture(callId);
  if (!state) return invoke(callId);
  const directive = call.transcript ?? context.transcript;
  try {
    const value = await invoke(callId);
    await finishCapture(state, context, config, directive, usageTags, {
      operation: call.operation,
      request: call.request,
      options: call.options ?? {},
      ...responseFrom(call.operation, value),
    });
    return value;
  } catch (error) {
    await finishCapture(state, context, config, directive, usageTags, {
      operation: call.operation,
      request: call.request,
      options: call.options ?? {},
      response: [],
      toolEvents: [],
      error,
    });
    throw error;
  }
}

const CAPTURED_METHODS = new Set(['message', 'chat', 'complete']);
const WRAPPED = Symbol.for('@happyvertical/smrt-core:aiTranscriptClient');

interface WrappedBrand {
  target: object;
  context: AiTranscriptContext;
}

/** The client a transcript wrapper wraps (itself when unwrapped). */
export function unwrapAiTranscriptClient<T>(client: T): T {
  const brand =
    client && typeof client === 'object'
      ? ((client as Record<symbol, unknown>)[WRAPPED] as
          | WrappedBrand
          | undefined)
      : undefined;
  return (brand?.target as T) ?? client;
}

/** Split a call's options into the provider's and the capture directive. */
function prepareOptions(
  raw: unknown,
  context: AiTranscriptContext,
): {
  options: Record<string, unknown>;
  directive: boolean | undefined;
  usageTags: Record<string, string>;
  callId: string;
} {
  const { transcript, ...options } =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const usageTags = stringRecord(options.usageTags);
  const callId = text(usageTags[AI_CALL_ID_TAG]) ?? newAiCallId();
  usageTags[AI_CALL_ID_TAG] = callId;
  return {
    options: { ...options, usageTags },
    directive:
      typeof transcript === 'boolean' ? transcript : context.transcript,
    usageTags,
    callId,
  };
}

function stripDirective(args: unknown[]): unknown[] {
  const raw = args[1];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return args;
  if (!('transcript' in raw)) return args;
  const { transcript: _transcript, ...options } = raw as Record<
    string,
    unknown
  >;
  return [args[0], options, ...args.slice(2)];
}

async function capturePromise(
  target: object,
  method: string,
  fn: (...args: unknown[]) => unknown,
  args: unknown[],
  context: AiTranscriptContext,
): Promise<unknown> {
  const config = resolveAiTranscriptConfig();
  if (!config.enabled) return fn.apply(target, stripDirective(args));
  const [input] = args;
  const prepared = prepareOptions(args[1], context);
  const state = beginCapture(prepared.callId);
  const callArgs = [input, prepared.options, ...args.slice(2)];
  if (!state) return fn.apply(target, callArgs);
  const request = requestMessages(method, input, prepared.options);
  try {
    const value = await fn.apply(target, callArgs);
    await finishCapture(
      state,
      context,
      config,
      prepared.directive,
      prepared.usageTags,
      {
        operation: method,
        request,
        options: prepared.options,
        ...responseFrom(method, value),
      },
    );
    return value;
  } catch (error) {
    await finishCapture(
      state,
      context,
      config,
      prepared.directive,
      prepared.usageTags,
      {
        operation: method,
        request,
        options: prepared.options,
        response: [],
        toolEvents: [],
        error,
      },
    );
    throw error;
  }
}

function captureStream(
  target: object,
  fn: (...args: unknown[]) => unknown,
  args: unknown[],
  context: AiTranscriptContext,
): AsyncIterable<string> {
  const config = resolveAiTranscriptConfig();
  if (!config.enabled) {
    return fn.apply(target, stripDirective(args)) as AsyncIterable<string>;
  }
  const [input] = args;
  const prepared = prepareOptions(args[1], context);
  const callArgs = [input, prepared.options, ...args.slice(2)];
  const state = beginCapture(prepared.callId);
  if (!state) return fn.apply(target, callArgs) as AsyncIterable<string>;
  const request = requestMessages('stream', input, prepared.options);
  return (async function* captured() {
    let assembled = '';
    let error: unknown;
    let failed = false;
    try {
      const source = fn.apply(target, callArgs) as AsyncIterable<string>;
      for await (const chunk of source) {
        assembled += typeof chunk === 'string' ? chunk : String(chunk);
        yield chunk;
      }
    } catch (caught) {
      failed = true;
      error = caught;
      throw caught;
    } finally {
      await finishCapture(
        state,
        context,
        config,
        prepared.directive,
        prepared.usageTags,
        {
          operation: 'stream',
          request,
          options: prepared.options,
          response: [{ role: 'assistant', content: assembled }],
          toolEvents: [],
          ...(failed ? { error } : {}),
        },
      );
    }
  })();
}

/**
 * Wrap an AI client so its `message()`, `chat()`, `complete()` and
 * `stream()` calls carry a `callId` usage tag and store transcripts per
 * the app's `inference.transcripts` config. Everything else passes through
 * bound to the client. A per-call `transcript: boolean` option is consumed
 * here and never reaches the provider. Re-wrapping a wrapped client wraps
 * its original with the merged context, so a call is captured once.
 *
 * The config is read per call: wrapping is cheap and safe while disabled,
 * but core only wraps while enabled, keeping client identity unchanged
 * otherwise.
 */
export function withAiTranscripts<T>(
  client: T,
  context: AiTranscriptContext,
): T {
  if (!client || typeof client !== 'object') return client;
  const existing = (client as Record<symbol, unknown>)[WRAPPED] as
    | WrappedBrand
    | undefined;
  const target = (existing?.target ?? client) as object;
  const merged: AiTranscriptContext = {
    ...(existing?.context ?? {}),
    ...context,
  };
  const brand: WrappedBrand = { target, context: merged };
  return new Proxy(target, {
    get(inner, property) {
      if (property === WRAPPED) return brand;
      const value = Reflect.get(inner, property, inner);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof property === 'string' && CAPTURED_METHODS.has(property)) {
        return (...args: unknown[]) =>
          capturePromise(inner, property, fn, args, merged);
      }
      if (property === 'stream') {
        return (...args: unknown[]) => captureStream(inner, fn, args, merged);
      }
      return fn.bind(inner);
    },
  }) as T;
}

/**
 * {@link withAiTranscripts} when the app enables transcripts, else `client`
 * unchanged (identity and options preserved: the parity contract).
 */
export function maybeWithAiTranscripts<T>(
  client: T,
  context: AiTranscriptContext | (() => AiTranscriptContext),
): T {
  if (!client || !aiTranscriptsEnabled()) return client;
  return withAiTranscripts(
    client,
    typeof context === 'function' ? context() : context,
  );
}
