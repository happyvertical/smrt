/**
 * Opt-in AI call transcripts (#4780) on SQLite: off by default, forced
 * classes at `sample: 0`, sampling, the byte cap, redaction (a configured key
 * is never stored), `transcript: false`, tenant-scoped and audited reads,
 * retention, and the `call_id` shared by usage rows, transcripts and labels.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import {
  aiTranscriptCaptureReason,
  captureAiTranscriptCall,
  fitAiTranscript,
  noteAiTranscriptRun,
  observeAiTranscriptUsage,
  redactAiTranscriptMessages,
  resolveAiTranscriptConfig,
  setTranscriptRedactor,
  withAiTranscripts,
} from '../ai-transcripts.js';
import { SmrtClass } from '../class.js';
import { config } from '../config.js';
import { field } from '../decorators';
import { resolveInferenceTarget } from '../inference-target.js';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import {
  AiTranscriptScopeError,
  listAiTranscripts,
} from '../system/ai-transcripts.js';
import {
  listAiUsageOutcomes,
  recordAiUsageOutcome,
  reportAiUsage,
} from '../system/ai-usage-observability.js';
import { runRetentionSweep } from '../system/retention.js';
import { getTestDatabase } from '../testing/database';

const KEY = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX0123';
const BASE_AI = { provider: 'openai', apiKey: KEY, model: 'base-model' };
const DAY = 86_400_000;

class Probe extends SmrtClass {
  async client() {
    return this.getAiClient();
  }
  async prepare(options: Record<string, unknown>) {
    return this.prepareAiOperation(options);
  }
}

@smrt()
class Issue4780Account extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text', sensitive: true })
  accountSecret: string = '';
}

interface FakeClient {
  embed: () => void;
  message: ReturnType<typeof vi.fn>;
  stream: (messages: unknown, options?: Record<string, unknown>) => unknown;
  options: Record<string, unknown>;
}

/** What the fake provider answers next; `Error` instances are thrown. */
let reply: string | Error = 'ok';
/** Extra usage tags the fake provider adds to its usage event. */
let eventTags: Record<string, string> = {};

function usageEvent(options: Record<string, unknown>, callOptions: unknown) {
  const tags = {
    ...(((callOptions as { usageTags?: Record<string, string> })?.usageTags ??
      {}) as Record<string, string>),
    ...eventTags,
  };
  (options.onUsage as ((event: unknown) => void) | undefined)?.({
    provider: 'openai',
    model: 'base-model',
    operation: 'message',
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    duration: 1,
    timestamp: new Date(),
    tags,
  });
}

function fakeClient(options: Record<string, unknown>): FakeClient {
  return {
    embed: () => {},
    options,
    message: vi.fn(async (_text: string, callOptions?: unknown) => {
      if (reply instanceof Error) throw reply;
      usageEvent(options, callOptions);
      return reply;
    }),
    stream: (_messages: unknown, callOptions?: Record<string, unknown>) =>
      (async function* () {
        usageEvent(options, callOptions);
        yield 'Hel';
        yield 'lo';
      })(),
  };
}

async function rows(db: DatabaseInterface, sql: string, ...params: unknown[]) {
  const result = (await db.query(sql, ...params)) as unknown;
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Record<string, unknown>[];
}

const ENV_KEYS = [
  'SMRT_AI_PROVIDER',
  'SMRT_AI_API_KEY',
  'SMRT_AI_MODEL',
  'OPENAI_API_KEY',
  'SMRT_INFERENCE_TRANSCRIPTS',
];

describe('AI call transcripts (#4780)', () => {
  let db: DatabaseInterface;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    config.reset();
    clearRuntimeConfig();
    setTranscriptRedactor(undefined);
    reply = 'ok';
    eventTags = {};
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (options: Record<string, unknown>) =>
      fakeClient(options),
    );
    db = await getTestDatabase({ classes: [] });
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    config.reset();
    clearRuntimeConfig();
    setTranscriptRedactor(undefined);
    vi.restoreAllMocks();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  function enable(transcripts: Record<string, unknown> = {}) {
    config({
      inference: { transcripts: { enabled: true, sample: 0, ...transcripts } },
    } as never);
  }

  const probe = async (tenantId?: string) => {
    const instance = new Probe({
      ai: BASE_AI,
      db,
      ...(tenantId ? { tenantId } : {}),
    } as never);
    await instance.initialize();
    // SmrtClass has no tenant field; set it the way a tenant-owned object has.
    if (tenantId) Object.assign(instance, { tenantId });
    return instance;
  };

  async function transcriptRows() {
    return rows(db, 'SELECT * FROM _smrt_ai_transcripts ORDER BY created_at');
  }

  describe('config', () => {
    it('is off by default and validates the block', () => {
      expect(resolveAiTranscriptConfig()).toEqual({
        enabled: false,
        sample: 0.1,
        maxBytes: 65_536,
        prompts: {},
      });
      config({ inference: { transcripts: { sample: 2 } } } as never);
      expect(() => resolveAiTranscriptConfig()).toThrow(/sample/);
      config.reset();
      config({ inference: { transcripts: { maxBytes: 10 } } } as never);
      expect(() => resolveAiTranscriptConfig()).toThrow(/maxBytes/);
    });

    it('SMRT_INFERENCE_TRANSCRIPTS enables over config and rejects junk', () => {
      process.env.SMRT_INFERENCE_TRANSCRIPTS = '1';
      expect(resolveAiTranscriptConfig().enabled).toBe(true);
      config({ inference: { transcripts: { enabled: true } } } as never);
      process.env.SMRT_INFERENCE_TRANSCRIPTS = 'off';
      expect(resolveAiTranscriptConfig().enabled).toBe(false);
      process.env.SMRT_INFERENCE_TRANSCRIPTS = 'maybe';
      expect(() => resolveAiTranscriptConfig()).toThrow(
        /SMRT_INFERENCE_TRANSCRIPTS/,
      );
    });

    it('ignores an instance inference option: app level only', async () => {
      const instance = new Probe({
        ai: BASE_AI,
        db,
        inference: { transcripts: { enabled: true, sample: 1 } },
      } as never);
      await instance.initialize();
      const ai = await instance.client();
      await ai.message('hello');
      expect(await transcriptRows()).toHaveLength(0);
    });
  });

  it('stores nothing and changes nothing while disabled', async () => {
    const instance = await probe();
    const raw = (await instance.client()) as unknown as FakeClient;
    expect(raw.message).toBeDefined();
    // Identity and options are untouched (the #4750 parity contract).
    expect(await instance.client()).toBe(raw);
    await (
      raw as unknown as { message: (t: string, o: unknown) => unknown }
    ).message('hello', { temperature: 0.2 });
    expect(raw.message.mock.calls[0]?.[1]).toEqual({ temperature: 0.2 });
    expect(await transcriptRows()).toHaveLength(0);
    const usage = await rows(db, 'SELECT call_id FROM _smrt_ai_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0]?.call_id ?? null).toBeNull();
  });

  describe('enabled at sample 0', () => {
    it('lifts callId to call_id but stores no sampled-out success', async () => {
      enable();
      const ai = await (await probe()).client();
      expect(await ai.message('hello')).toBe('ok');
      const usage = await rows(db, 'SELECT call_id, tags FROM _smrt_ai_usage');
      expect(usage).toHaveLength(1);
      expect(usage[0]?.call_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(String(usage[0]?.tags)).callId).toBe(usage[0]?.call_id);
      expect(await transcriptRows()).toHaveLength(0);
    });

    it('always stores transcript: true, failures and substitutions', async () => {
      enable();
      const ai = await (await probe()).client();
      await ai.message('asked for it', { transcript: true } as never);
      reply = new Error('provider exploded');
      await expect(ai.message('this fails')).rejects.toThrow('exploded');
      reply = 'fallback answer';
      eventTags = {
        substitutions: JSON.stringify([
          { from: 'great', to: 'good', reason: 'quota' },
        ]),
      };
      await ai.message('fell back');
      eventTags = { substitutions: '[]' };
      await ai.message('no substitution');

      const stored = await transcriptRows();
      expect(stored).toHaveLength(3);
      const captures = stored.map(
        (row) => JSON.parse(String(row.response)).capture,
      );
      expect(captures).toEqual(['requested', 'failed', 'substituted']);
      const failed = JSON.parse(String(stored[1]?.response));
      expect(failed.messages.at(-1)).toMatchObject({
        role: 'error',
        content: 'provider exploded',
      });
      // The transcript directive never reaches the provider.
      const fake = getAIMock.mock.results[0]?.value as Promise<FakeClient>;
      const firstCall = (await fake).message.mock.calls[0]?.[1];
      expect(firstCall).not.toHaveProperty('transcript');
      expect(firstCall.usageTags.callId).toBe(stored[0]?.call_id);
    });

    it('never stores transcript: false, even for a failure', async () => {
      enable({ sample: 1 });
      const ai = await (await probe()).client();
      await ai.message('private', { transcript: false } as never);
      reply = new Error('boom');
      await expect(
        ai.message('private failure', { transcript: false } as never),
      ).rejects.toThrow('boom');
      expect(await transcriptRows()).toHaveLength(0);
      // The call is still identified on its usage row.
      const usage = await rows(db, 'SELECT call_id FROM _smrt_ai_usage');
      expect(usage[0]?.call_id).toBeTruthy();
    });

    it('takes the directive from prepareAiOperation options', async () => {
      enable();
      const prepared = await (await probe()).prepare({
        transcript: true,
        temperature: 0.1,
      });
      expect(prepared.aiOptions).toEqual({ temperature: 0.1 });
      await prepared.ai.message('prepared', prepared.aiOptions as never);
      expect(await transcriptRows()).toHaveLength(1);
    });

    it('assembles streamed chunks', async () => {
      enable();
      const ai = (await (await probe()).client()) as unknown as FakeClient;
      const chunks: string[] = [];
      for await (const chunk of ai.stream(
        [{ role: 'user', content: 'stream please' }],
        { transcript: true },
      ) as AsyncIterable<string>) {
        chunks.push(chunk);
      }
      expect(chunks.join('')).toBe('Hello');
      const [row] = await transcriptRows();
      expect(row?.operation).toBe('stream');
      expect(JSON.parse(String(row?.response)).messages[0].content).toBe(
        'Hello',
      );
      expect(JSON.parse(String(row?.request)).messages[0].content).toBe(
        'stream please',
      );
    });

    it('forces a call whose fusion run degraded', async () => {
      enable();
      const context = { db, className: 'FusionProbe' };
      await captureAiTranscriptCall(
        context,
        { operation: 'message', request: [{ role: 'user', content: 'q' }] },
        async (callId) => {
          // A seat's usage event links the call to its run, then the run
          // record reports degraded.
          observeAiTranscriptUsage({
            provider: 'openai',
            model: 'seat-model',
            tags: { callId, runId: 'run-1', seat: 'skeptic' },
          });
          noteAiTranscriptRun('run-1', 'degraded');
          return 'answer';
        },
      );
      await captureAiTranscriptCall(
        context,
        { operation: 'message', request: [{ role: 'user', content: 'q2' }] },
        async (callId) => {
          observeAiTranscriptUsage({ tags: { callId, runId: 'run-2' } });
          noteAiTranscriptRun('run-2', 'ok');
          return 'answer';
        },
      );
      const stored = await transcriptRows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ run_id: 'run-1', model: 'seat-model' });
      expect(JSON.parse(String(stored[0]?.response)).capture).toBe(
        'degraded-run',
      );
    });
  });

  it('honours the sample rate statistically, per prompt key too', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const draw = (sample: number) => {
      let captured = 0;
      for (let i = 0; i < 4000; i++) {
        if (
          aiTranscriptCaptureReason(
            { failed: false, substituted: false, degradedRun: false, sample },
            random,
          )
        ) {
          captured++;
        }
      }
      return captured / 4000;
    };
    expect(draw(0.1)).toBeGreaterThan(0.08);
    expect(draw(0.1)).toBeLessThan(0.12);
    expect(draw(0.5)).toBeGreaterThan(0.46);
    expect(draw(0.5)).toBeLessThan(0.54);
    expect(draw(0)).toBe(0);
    expect(draw(1)).toBe(1);
  });

  it('applies a per-prompt sample override', async () => {
    enable({ sample: 0, prompts: { 'notes.review': { sample: 1 } } });
    const ai = await (await probe()).client();
    await ai.message('sampled', { usageTags: { promptKey: 'notes.review' } });
    await ai.message('not sampled', { usageTags: { promptKey: 'other' } });
    const stored = await transcriptRows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.prompt_key).toBe('notes.review');
  });

  describe('size cap', () => {
    it('keeps head and tail and flags truncation', () => {
      const big = JSON.stringify({ text: 'a'.repeat(5000) + 'TAIL' });
      const fitted = fitAiTranscript(
        { request: big, response: '{"x":1}', toolEvents: null },
        1024,
      );
      expect(fitted.truncated).toBe(true);
      expect(fitted.bytes).toBeLessThanOrEqual(1024);
      expect(fitted.response).toBe('{"x":1}');
      const envelope = JSON.parse(String(fitted.request));
      expect(envelope).toMatchObject({
        truncated: true,
        originalBytes: Buffer.byteLength(big),
      });
      expect(envelope.head.startsWith('{"text":"aaa')).toBe(true);
      expect(envelope.tail.endsWith('TAIL"}')).toBe(true);
    });

    it('stores at most maxBytes per row', async () => {
      enable({ maxBytes: 2048 });
      const ai = await (await probe()).client();
      await ai.message('x'.repeat(10_000), { transcript: true } as never);
      const [row] = await transcriptRows();
      expect(Number(row?.truncated)).toBe(1);
      expect(Number(row?.bytes)).toBeLessThanOrEqual(2048);
      expect(
        Buffer.byteLength(String(row?.request)) +
          Buffer.byteLength(String(row?.response)),
      ).toBe(Number(row?.bytes));
    });
  });

  describe('redaction', () => {
    it('never stores the configured API key; runs the host redactor first', async () => {
      enable();
      const seen: string[] = [];
      setTranscriptRedactor((messages, context) => {
        seen.push(context.part);
        return messages.map((message) =>
          typeof message.content === 'string'
            ? {
                ...message,
                content: message.content.replace('Jane Doe', '[name]'),
              }
            : message,
        );
      });
      const ai = await (await probe()).client();
      await ai.message(
        `Jane Doe pasted ${KEY} and Bearer abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz0123`,
        { transcript: true } as never,
      );
      const [row] = await transcriptRows();
      const stored = JSON.stringify(row);
      expect(stored).not.toContain(KEY);
      expect(stored).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
      expect(stored).not.toContain('Jane Doe');
      expect(stored).toContain('[name]');
      expect(seen.sort()).toEqual(['request', 'response']);
    });

    it('masks credential-named fields and exact secret values', () => {
      const [message] = redactAiTranscriptMessages(
        [
          {
            role: 'tool-call',
            content: { apiKey: 'zzz-secret', query: 'my-own-pass-1234 here' },
          },
        ],
        {
          secrets: ['my-own-pass-1234'],
          sensitive: [{ field: 'ssn', value: 'abc' }],
        },
      );
      expect(message?.content).toEqual({
        apiKey: '[REDACTED]',
        query: '[REDACTED] here',
      });
    });

    it('masks the calling object’s sensitive field values', async () => {
      enable();
      const account = new Issue4780Account({ ai: BASE_AI, db } as never);
      await account.initialize();
      account.name = 'Acme';
      account.accountSecret = 'hunter2-account-secret';
      // A prompt that quotes the sensitive value verbatim.
      await account.do('Mention hunter2-account-secret in the reply', {
        transcript: true,
      });
      const [row] = await transcriptRows();
      const stored = JSON.stringify(row);
      expect(stored).not.toContain('hunter2-account-secret');
      expect(stored).toContain('[REDACTED:accountSecret]');
      expect(row?.class_name).toBe('Issue4780Account');
    });
  });

  describe('reads', () => {
    async function seedTwoTenants() {
      enable();
      await (await (await probe('t1')).client()).message('t1 question', {
        transcript: true,
      } as never);
      await (await (await probe('t2')).client()).message('t2 question', {
        transcript: true,
      } as never);
    }

    it('requires a tenant scope or the explicit cross-tenant path', async () => {
      await seedTwoTenants();
      await expect(listAiTranscripts(db, { actor: 'tester' })).rejects.toThrow(
        AiTranscriptScopeError,
      );
      await expect(
        listAiTranscripts(db, { actor: '', tenantId: 't1' }),
      ).rejects.toThrow(/actor/);
      const t1 = await listAiTranscripts(db, {
        actor: 'tester',
        tenantId: 't1',
      });
      expect(t1).toHaveLength(1);
      expect(t1[0]?.tenantId).toBe('t1');
      expect(
        (t1[0]?.request as { messages?: Array<{ content: string }> })
          ?.messages?.[0]?.content,
      ).toBe('t1 question');
      expect(t1[0]?.usage).toHaveLength(1);
      expect(t1[0]?.usage[0]?.callId).toBe(t1[0]?.callId);
      expect(
        await listAiTranscripts(db, { actor: 'x', tenantId: null }),
      ).toEqual([]);
      const all = await listAiTranscripts(db, {
        actor: 'operator',
        allowCrossTenant: true,
      });
      expect(all.map((row) => row.tenantId).sort()).toEqual(['t1', 't2']);
    });

    it('writes one audit event per transcript read', async () => {
      await seedTwoTenants();
      const writer = vi.fn(async () => {});
      const read = await listAiTranscripts(db, {
        actor: 'auditor',
        reason: 'tuning',
        allowCrossTenant: true,
        audit: writer,
      });
      expect(writer).toHaveBeenCalledTimes(2);
      expect(writer.mock.calls.map((call) => call[0])).toEqual(
        read.map((row) =>
          expect.objectContaining({
            actorId: 'auditor',
            reason: 'tuning',
            action: 'read',
            resourceType: '_smrt_ai_transcripts',
            resourceId: row.id,
            tenantId: row.tenantId,
          }),
        ),
      );
      // A failing writer fails the read: content is never returned unaudited.
      await expect(
        listAiTranscripts(db, {
          actor: 'auditor',
          tenantId: 't1',
          audit: async () => {
            throw new Error('audit down');
          },
        }),
      ).rejects.toThrow('audit down');
    });

    it('labels a call by callId and joins labels to the transcript', async () => {
      await seedTwoTenants();
      const [t1] = await listAiTranscripts(db, { actor: 'x', tenantId: 't1' });
      const callId = String(t1?.callId);
      const label = await recordAiUsageOutcome(db, {
        callId,
        label: 'rejected',
        score: 0.1,
        actor: 'reviewer',
      });
      expect(label).toMatchObject({ callId, tenantId: 't1' });
      await expect(
        recordAiUsageOutcome(db, {
          callId,
          label: 'x',
          actor: 'r',
          tenantId: 't2',
        }),
      ).rejects.toThrow(/tenant/);
      await expect(
        recordAiUsageOutcome(db, { callId: 'nope', label: 'x', actor: 'r' }),
      ).rejects.toThrow(/call_id/);

      const [joined] = await listAiTranscripts(db, {
        actor: 'x',
        tenantId: 't1',
        outcome: 'rejected',
      });
      expect(joined?.outcomes.map((outcome) => outcome.label)).toEqual([
        'rejected',
      ]);
      expect(
        await listAiTranscripts(db, {
          actor: 'x',
          tenantId: 't2',
          labelled: true,
        }),
      ).toEqual([]);
      const outcomes = await listAiUsageOutcomes(db, { callId });
      expect(outcomes[0]?.usage.map((row) => row.callId)).toEqual([callId]);
      const report = await reportAiUsage(db, { by: ['tenant'] });
      expect(report.totals.outcomes).toEqual({ rejected: 1 });
    });
  });

  it('retention prunes transcripts only, on their own window', async () => {
    enable();
    await (await (await probe('t1')).client()).message('old', {
      transcript: true,
    } as never);
    const old = new Date(Date.now() - 31 * DAY).toISOString();
    await db.query('UPDATE _smrt_ai_transcripts SET created_at = $1', old);
    await db.query('UPDATE _smrt_ai_usage SET created_at = $1', old);
    const result = await runRetentionSweep(db, {});
    const task = result.tasks.find((entry) => entry.task === 'ai-transcripts');
    expect(task?.pruned).toBe(1);
    expect(await transcriptRows()).toHaveLength(0);
    expect(await rows(db, 'SELECT id FROM _smrt_ai_usage')).toHaveLength(1);
  });

  it('instruments raw tier clients through resolveInferenceTarget()', async () => {
    enable();
    const raw = fakeClient({ provider: 'openai', apiKey: KEY });
    const quiet = await resolveInferenceTarget({
      base: BASE_AI,
      transcript: false,
      usage: { db },
    });
    expect(quiet.instrument(raw)).toBe(raw);
    const resolved = await resolveInferenceTarget({
      base: BASE_AI,
      className: 'RawSite',
      tenantId: 't9',
      usage: { db, tenantId: 't9' },
    });
    const ai = resolved.instrument(raw);
    expect(ai).not.toBe(raw);
    await ai.message(`raw ${KEY}`, { transcript: true } as never);
    const [row] = await transcriptRows();
    expect(row).toMatchObject({ class_name: 'RawSite', tenant_id: 't9' });
    expect(JSON.stringify(row)).not.toContain(KEY);
  });

  it('withAiTranscripts passes non-captured members through, bound', async () => {
    enable();
    class Client {
      #secret = 'private-state';
      read() {
        return this.#secret;
      }
      async message() {
        return 'm';
      }
    }
    const wrapped = withAiTranscripts(new Client(), { db });
    expect(wrapped.read()).toBe('private-state');
    expect(wrapped).toBeInstanceOf(Client);
  });
});
