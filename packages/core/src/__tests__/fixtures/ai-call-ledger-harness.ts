/**
 * A programmable provider client for the call-ledger tests (#5516): what the
 * mocked `getAI()` returns. It declares `usageFeatures.parts` when the
 * script says so (the capability sdk#1576 adds), emits usage events through
 * the provider-level `onUsage` the core-built config carries, optionally
 * with the call's usage tags echoed and a producer-assigned `part`, and can
 * hold events back to deliver them after the call returned (a late part).
 *
 * The test file mocks `@happyvertical/ai` and points `getAI` at
 * {@link stubGetAI}; nothing here talks to a provider.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { rowsOf } from './ai-run-test-db';

/** One usage event a stub call emits. */
export interface StubEmit {
  /** The producer's part index; omitted with `noPart`. */
  index?: number;
  last?: true;
  /** Token counts; `null` for a count-less part. */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null;
  model?: string;
  /** Emit without a `part` even from a parts-mode client. */
  noPart?: boolean;
  /** Replace the event's fields wholesale (malformed-input cases). */
  raw?: Record<string, unknown>;
  /** Tags to send instead of the echoed call tags. */
  tags?: unknown;
  /** The SDK call id to stamp instead of the call's own. */
  sdkCall?: string;
}

/** What a scripted call sees. */
export interface StubCall {
  method: string;
  input: unknown;
  options: Record<string, unknown>;
  /** The SDK call id minted for this invocation. */
  sdkCall: string;
  /** Emit now through the provider-level callback. */
  emit(event: StubEmit): Promise<void>;
  /** Keep for {@link flushHeld}. */
  hold(event: StubEmit): void;
  /** The event the stub would emit, without emitting it. */
  build(event: StubEmit): Record<string, unknown>;
}

/** The script every stub client follows. */
export interface StubScript {
  /** Declare `usageFeatures: { parts: true }`. */
  parts: boolean;
  /** Echo the call's usage tags on each event (the SDK does). */
  echo: boolean;
  /** The provider name events report. */
  provider: string;
  /** What one call does; default: one counted last part, 6 + 4 tokens. */
  onCall?: (call: StubCall) => Promise<unknown> | unknown;
  /** Stream chunks yielded; usage emitted by `onCall` before the first. */
  chunks?: string[];
}

interface StubState {
  script: StubScript;
  /** Options each request was sent with (what the SDK saw). */
  sent: Record<string, unknown>[];
  held: Record<string, unknown>[];
  requests: number;
  onUsage: ((event: unknown) => unknown) | null;
  calls: number;
}

export const stub: StubState = {
  script: { parts: true, echo: true, provider: 'openai' },
  sent: [],
  held: [],
  requests: 0,
  onUsage: null,
  calls: 0,
};

/** Reset the stub between tests. */
export function resetStub(script: Partial<StubScript> = {}): void {
  stub.script = { parts: true, echo: true, provider: 'openai', ...script };
  stub.sent = [];
  stub.held = [];
  stub.requests = 0;
  stub.onUsage = null;
  stub.calls = 0;
}

function buildEvent(
  options: Record<string, unknown>,
  sdkCall: string,
  event: StubEmit,
): Record<string, unknown> {
  if (event.raw) return { ...event.raw };
  const usage =
    event.usage === null
      ? undefined
      : (event.usage ?? {
          promptTokens: 6,
          completionTokens: 4,
          totalTokens: 10,
        });
  const tags =
    event.tags !== undefined
      ? event.tags
      : stub.script.echo
        ? { ...((options.usageTags as Record<string, string>) ?? {}) }
        : undefined;
  return {
    provider: stub.script.provider,
    model: event.model ?? 'gpt-4o',
    operation: 'message',
    ...(usage ? { usage } : {}),
    duration: 3,
    timestamp: new Date(),
    ...(tags !== undefined ? { tags } : {}),
    ...(stub.script.parts && !event.noPart
      ? {
          part: {
            call: event.sdkCall ?? sdkCall,
            index: event.index ?? 0,
            ...(event.last ? { last: true } : {}),
          },
        }
      : {}),
  };
}

async function deliver(event: Record<string, unknown>): Promise<void> {
  await stub.onUsage?.(event);
}

/** Emit every held event through the provider-level callback, in order. */
export async function flushHeld(): Promise<void> {
  for (const event of stub.held.splice(0)) await deliver(event);
}

function makeCall(
  method: string,
  input: unknown,
  options: Record<string, unknown>,
): StubCall {
  stub.calls++;
  const sdkCall = `sdk-call-${stub.calls}`;
  return {
    method,
    input,
    options,
    sdkCall,
    build: (event) => buildEvent(options, sdkCall, event),
    emit: (event) => deliver(buildEvent(options, sdkCall, event)),
    hold: (event) => {
      stub.held.push(buildEvent(options, sdkCall, event));
    },
  };
}

async function defaultCall(call: StubCall): Promise<unknown> {
  await call.emit({ index: 0, last: true });
  return call.method === 'message' ? 'answer' : { content: 'answer' };
}

/** The mocked `getAI()`: a client that follows {@link stub}'s script. */
export async function stubGetAI(
  aiConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  stub.onUsage = aiConfig.onUsage as (event: unknown) => unknown;
  const run = async (method: string, input: unknown, raw: unknown) => {
    const options = (raw ?? {}) as Record<string, unknown>;
    stub.requests++;
    stub.sent.push(options);
    const call = makeCall(method, input, options);
    return (stub.script.onCall ?? defaultCall)(call);
  };
  const client: Record<string, unknown> = {
    message: (input: unknown, options?: unknown) =>
      run('message', input, options),
    chat: (input: unknown, options?: unknown) => run('chat', input, options),
    complete: (input: unknown, options?: unknown) =>
      run('complete', input, options),
    stream: (input: unknown, raw?: unknown) =>
      (async function* () {
        const options = (raw ?? {}) as Record<string, unknown>;
        stub.requests++;
        stub.sent.push(options);
        const call = makeCall('stream', input, options);
        await (stub.script.onCall ?? defaultCall)(call);
        for (const chunk of stub.script.chunks ?? ['a', 'b']) yield chunk;
      })(),
  };
  if (stub.script.parts) {
    Object.defineProperty(client, 'usageFeatures', {
      value: Object.freeze({ parts: true }),
      enumerable: true,
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/** One call event as the ledger stores it, JSON columns parsed. */
export interface LedgerCall {
  id: string;
  runId: string;
  callId: string;
  callState: string;
  status: string | null;
  endedAt: string | null;
  usageSource: string | null;
  chargedTokens: number | null;
  chargedCost: number | null;
  callRate: { input: number; output: number } | null;
  callProof: string | null;
  callRow: Record<string, unknown> | null;
  callUsage: Record<string, unknown> | null;
  reservedTokens: number;
  createdAt: unknown;
}

function json(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  return JSON.parse(String(value)) as Record<string, unknown>;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Every `call` event of a run, in `seq` order. */
export async function readCalls(
  db: DatabaseInterface,
  runId: string,
): Promise<LedgerCall[]> {
  const rows = rowsOf(
    await db.query(
      `SELECT id, run_id, call_id, call_state, status, ended_at, usage_source,
              charged_tokens, charged_cost, call_rate, call_proof, call_row,
              call_usage, reserved_tokens, created_at
         FROM _smrt_ai_run_events
        WHERE run_id = $1 AND type = 'call'
        ORDER BY seq`,
      runId,
    ),
  );
  return rows.map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    callId: String(row.call_id),
    callState: String(row.call_state),
    status: row.status === null ? null : String(row.status),
    endedAt:
      row.ended_at === null || row.ended_at === undefined
        ? null
        : String(row.ended_at),
    usageSource: row.usage_source === null ? null : String(row.usage_source),
    chargedTokens: nullableNumber(row.charged_tokens),
    chargedCost: nullableNumber(row.charged_cost),
    callRate: json(row.call_rate) as LedgerCall['callRate'],
    callProof: row.call_proof === null ? null : String(row.call_proof),
    callRow: json(row.call_row),
    callUsage: json(row.call_usage),
    reservedTokens: Number(row.reserved_tokens ?? 0),
    createdAt: row.created_at,
  }));
}

/** The one call event of a run (throws unless there is exactly one). */
export async function readOnlyCall(
  db: DatabaseInterface,
  runId: string,
): Promise<LedgerCall> {
  const calls = await readCalls(db, runId);
  if (calls.length !== 1) {
    throw new Error(`expected one call event, found ${calls.length}`);
  }
  return calls[0] as LedgerCall;
}

/** The usage rows of the database, oldest first, tags parsed. */
export async function usageRows(
  db: DatabaseInterface,
): Promise<Record<string, unknown>[]> {
  return rowsOf(
    await db.query(
      `SELECT id, run_id, tenant_id, provider, model, prompt_tokens,
              completion_tokens, total_tokens, estimated_cost, tags, created_at
         FROM _smrt_ai_usage ORDER BY created_at, id`,
    ),
  ).map((row) => ({
    ...row,
    prompt_tokens: nullableNumber(row.prompt_tokens),
    completion_tokens: nullableNumber(row.completion_tokens),
    total_tokens: nullableNumber(row.total_tokens),
    estimated_cost: nullableNumber(row.estimated_cost),
    tags: json(row.tags),
  }));
}

/** A tenant's spend: tokens and cost over its usage rows. */
export async function tenantSpend(
  db: DatabaseInterface,
  tenantId: string | null,
): Promise<{ rows: number; tokens: number; cost: number }> {
  const row = rowsOf(
    await db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(estimated_cost), 0) AS cost
         FROM _smrt_ai_usage
        WHERE ${tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = $1'}`,
      ...(tenantId === null ? [] : [tenantId]),
    ),
  )[0];
  return {
    rows: Number(row?.n ?? 0),
    tokens: Number(row?.tokens ?? 0),
    cost: Number(row?.cost ?? 0),
  };
}

/** Move a call's first end back by `ms` (the window counts from it). */
export async function ageCallEnd(
  db: DatabaseInterface,
  callId: string,
  ms: number,
): Promise<void> {
  await db.query(
    `UPDATE _smrt_ai_run_events SET ended_at = $1
      WHERE call_id = $2 AND type = 'call'`,
    new Date(Date.now() - ms).toISOString(),
    callId,
  );
}

/** Fail the first closing write of a call once (its settlement queues). */
export function closingWrite(sql: string): boolean {
  return /^UPDATE _smrt_ai_run_events SET (reservation|call_state)/.test(sql);
}

export const MINUTE = 60_000;

/** The rate the fixtures price `openai:gpt-4o` at, per 1K tokens. */
export const FIXTURE_RATE = { input: 1, output: 2 };

/** A tracked client on a fresh database with one open run. */
export async function ledgerFixture(
  engine: 'sqlite' | 'duckdb' | 'pglite',
  options: {
    tenantId?: string | null;
    costed?: boolean;
    usage?: Record<string, unknown>;
    db?: DatabaseInterface;
    budget?: Record<string, number>;
  } = {},
) {
  const { newAiRunTestDatabase } = await import('./ai-run-test-db');
  const { createTrackedAiClient } = await import('../../tracked-ai-client');
  const db = options.db ?? (await newAiRunTestDatabase(engine));
  const tenantId =
    options.tenantId === undefined ? 'tenant-a' : options.tenantId;
  const tracked = createTrackedAiClient({
    db,
    tenantId,
    ai: { provider: 'openai', model: 'gpt-4o' } as never,
    usage: {
      ...(options.costed === false
        ? { estimateCosts: false }
        : { costRates: { 'openai:gpt-4o': FIXTURE_RATE } }),
      ...(options.usage ?? {}),
    } as never,
  });
  const { run, context } = await tracked.openRun({
    type: 'turn',
    ...(options.budget ? { budget: options.budget } : {}),
  });
  const client = (await tracked.client(
    { promptKey: 'fixture.prompt' },
    { runContext: context },
  )) as unknown as {
    message(input: unknown, options?: unknown): Promise<unknown>;
    chat(input: unknown, options?: unknown): Promise<unknown>;
    stream(input: unknown, options?: unknown): AsyncIterable<unknown>;
  };
  return { db, tracked, run, context, client, tenantId };
}

/** Read a run's own totals. */
export async function runTotals(db: DatabaseInterface, runId: string) {
  const row = rowsOf(
    await db.query(
      `SELECT tokens, cost_used, calls, uncosted_calls, inclusive_tokens,
              inclusive_cost, reserved_tokens, reserved_calls
         FROM _smrt_ai_runs WHERE id = $1`,
      runId,
    ),
  )[0];
  return {
    tokens: Number(row?.tokens),
    cost: Number(row?.cost_used),
    calls: Number(row?.calls),
    uncostedCalls: Number(row?.uncosted_calls),
    inclusiveTokens: Number(row?.inclusive_tokens),
    inclusiveCost: Number(row?.inclusive_cost),
    reservedTokens: Number(row?.reserved_tokens),
    reservedCalls: Number(row?.reserved_calls),
  };
}
