/**
 * Tests for `smrt ai:compare` and `smrt prompts:history` (#4782): selector
 * and scope parsing, the table, the side-by-side transcript layout and the
 * handlers end to end over core on in-memory SQLite.
 */

import {
  AiUsagePersistenceHandler,
  compareAiPromptRuns,
  ensureSystemTables,
  listAiPromptTemplateHistory,
  recordAiTranscript,
  recordAiUsageOutcome,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dbRef } = vi.hoisted(() => ({
  dbRef: { current: undefined as unknown },
}));

vi.mock('../ai-transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai-transcript.js')>();
  return { ...actual, openCliDatabase: async () => dbRef.current };
});

import {
  aiCompareCommand,
  formatAiPromptComparison,
  formatAiPromptTemplateHistory,
  formatSideBySide,
  parseCompareSelector,
  parseTranscriptCount,
  promptsHistoryCommand,
  usageScope,
} from '../ai-compare.js';

describe('ai:compare parsing', () => {
  it('parses hash:, model: and tier: selectors on the first colon', () => {
    expect(parseCompareSelector('hash:abc123', '--a')).toEqual({
      templateHash: 'abc123',
    });
    expect(parseCompareSelector('model:ollama:llama3:8b', '--a')).toEqual({
      model: 'ollama:llama3:8b',
    });
    expect(parseCompareSelector('TIER:good', '--b')).toEqual({ tier: 'good' });
    for (const bad of [undefined, '', 'abc', 'hash:', 'size:big', ':x']) {
      expect(() => parseCompareSelector(bad, '--a')).toThrow(/--a/);
    }
  });

  it('requires --tenant or --all-tenants, never both', () => {
    expect(() => usageScope({})).toThrow(/--tenant <id>/);
    expect(() => usageScope({ tenant: 't', 'all-tenants': true })).toThrow(
      /not both/,
    );
    expect(usageScope({ tenant: 't1' })).toEqual({ tenantId: 't1' });
    expect(usageScope({ tenant: 'global' })).toEqual({ tenantId: null });
    expect(usageScope({ 'all-tenants': true })).toEqual({
      allowCrossTenant: true,
    });
  });

  it('bounds --transcripts', () => {
    expect(parseTranscriptCount(undefined)).toBe(0);
    expect(parseTranscriptCount('3')).toBe(3);
    for (const bad of ['-1', '1.5', '21', 'x']) {
      expect(() => parseTranscriptCount(bad)).toThrow(/--transcripts/);
    }
  });

  it('declares its flags', () => {
    expect(aiCompareCommand.name).toBe('ai:compare');
    expect(Object.keys(aiCompareCommand.options ?? {})).toEqual([
      'prompt',
      'a',
      'b',
      'since',
      'until',
      'tenant',
      'all-tenants',
      'transcripts',
      'actor',
      'json',
    ]);
    expect(promptsHistoryCommand.name).toBe('prompts:history');
    expect(promptsHistoryCommand.args).toEqual(['<key>']);
  });
});

describe('ai:compare over SQLite', () => {
  let db: DatabaseInterface;
  let logs: string[];
  let errors: string[];

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await ensureSystemTables(db, 'sqlite');
    dbRef.current = db;
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.join(' '));
    });
    process.exitCode = undefined;
    const handler = new AiUsagePersistenceHandler(db);
    for (const [callId, tenantId, hash, duration] of [
      ['call-a1', 'tenant-a', 'h1', 100],
      ['call-a2', 'tenant-a', 'h1', 300],
      ['call-b1', 'tenant-a', 'h2', 50],
      ['call-x', 'tenant-b', 'h1', 999],
    ] as const) {
      await handler.handle({
        provider: 'openai',
        model: 'gpt-test',
        operation: 'message',
        usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
        duration,
        timestamp: new Date('2026-11-08T10:00:00Z'),
        tenantId,
        estimatedCost: 0.001,
        tags: { callId, promptKey: 'notes.review', templateHash: hash },
      });
      await recordAiTranscript(db, {
        callId,
        tenantId,
        promptKey: 'notes.review',
        templateHash: hash,
        provider: 'openai',
        model: 'gpt-test',
        operation: 'message',
        request: JSON.stringify({
          messages: [{ role: 'user', content: `question ${callId}` }],
        }),
        response: JSON.stringify({
          messages: [{ role: 'assistant', content: `answer ${callId}` }],
        }),
        toolEvents: null,
        truncated: false,
        bytes: 100,
      });
    }
    await recordAiUsageOutcome(db, {
      callId: 'call-a2',
      label: 'rejected',
      score: 0.1,
      actor: 'reviewer',
    });
    await recordAiUsageOutcome(db, {
      callId: 'call-b1',
      label: 'accepted',
      score: 0.9,
      actor: 'reviewer',
    });
    await recordAiUsageOutcome(db, {
      callId: 'call-x',
      label: 'rejected',
      score: 0,
      actor: 'reviewer',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await db.close?.();
  });

  it('renders the comparison table with its accounting', async () => {
    const result = await compareAiPromptRuns(db, {
      promptKey: 'notes.review',
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: 'tenant-a',
    });
    const text = formatAiPromptComparison(result);
    expect(text).toMatch(/metric\s+A hash:h1\s+B hash:h2/);
    expect(text).toMatch(/calls\s+2\s+1/);
    expect(text).toMatch(/p50\s+100ms\s+50ms/);
    expect(text).toMatch(/outcomes\s+rejected=1\s+accepted=1/);
    expect(text).toMatch(/mean score\s+0\.100 \(n=1\)\s+0\.900 \(n=1\)/);
    expect(text).toContain(
      'Rows of notes.review in scope: 3 (neither side: 0, both sides: 0)',
    );
    expect(text).toContain('Cost basis:');
  });

  it('prints the worst-labelled transcripts side by side, audited', async () => {
    await aiCompareCommand.handler?.([], {
      prompt: 'notes.review',
      a: 'hash:h1',
      b: 'hash:h2',
      tenant: 'tenant-a',
      transcripts: '2',
      actor: 'ops',
    });
    expect(errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    const out = logs.join('\n');
    expect(out).toContain('Worst-labelled transcripts (A | B, up to 2 each)');
    // One pair: A's only labelled call beside B's; tenant-b never appears.
    expect(out).toMatch(/Call: {6}call-a2\s+\| Call: {6}call-b1/);
    expect(out).toMatch(/question call-a2\s+\| question call-b1/);
    expect(out).not.toContain('call-x');
    expect(out).not.toContain('call-a1 ');
  });

  it('reads every chosen transcript of a call that has more than 20', async () => {
    // 24 more transcripts of call-a2 (all labelled through the call) at one
    // instant: the compare order (id ascending on ties) differs from the
    // read path's newest-first page (id descending), so a 20-row read per
    // reference would miss some of the chosen 20. One read per call does not.
    const at = new Date('2026-11-08T12:00:00Z');
    for (let index = 0; index < 24; index++) {
      await recordAiTranscript(db, {
        callId: 'call-a2',
        tenantId: 'tenant-a',
        promptKey: 'notes.review',
        operation: 'message',
        request: JSON.stringify({ messages: [] }),
        response: JSON.stringify({ messages: [] }),
        toolEvents: null,
        truncated: false,
        bytes: 10,
        createdAt: at,
      });
    }
    const result = await compareAiPromptRuns(db, {
      promptKey: 'notes.review',
      a: { templateHash: 'h1' },
      b: { templateHash: 'h2' },
      tenantId: 'tenant-a',
    });
    expect(result.a.transcriptCount).toBe(26);
    await aiCompareCommand.handler?.([], {
      prompt: 'notes.review',
      a: 'hash:h1',
      b: 'hash:h2',
      tenant: 'tenant-a',
      transcripts: '20',
      json: true,
    });
    const json = JSON.parse(logs.at(-1) ?? '{}');
    expect(json.worstTranscripts.a).toHaveLength(20);
    expect(
      json.worstTranscripts.a.map((row: { id: string }) => row.id),
    ).toEqual(result.a.transcripts.slice(0, 20).map((ref) => ref.id));
  });

  it('emits JSON and refuses a read without a tenant scope', async () => {
    await aiCompareCommand.handler?.([], {
      prompt: 'notes.review',
      a: 'hash:h1',
      b: 'model:openai:gpt-test',
      'all-tenants': true,
      json: true,
    });
    const json = JSON.parse(logs.at(-1) ?? '{}');
    expect(json).toMatchObject({ crossTenant: true, inBoth: 3, rows: 4 });
    expect(json.a.calls).toBe(3);
    expect(json.b.calls).toBe(4);

    logs = [];
    await aiCompareCommand.handler?.([], {
      prompt: 'notes.review',
      a: 'hash:h1',
      b: 'hash:h2',
      json: true,
    });
    expect(JSON.parse(logs.at(-1) ?? '{}').error).toMatch(/--tenant/);
    expect(process.exitCode).toBe(1);
  });

  it('lays out a missing side and wraps long lines', () => {
    // (60 - 5) / 2 = 27 columns per side.
    expect(formatSideBySide(undefined, undefined, 60)).toBe(
      `${'(none)'.padEnd(27)} | (none)`,
    );
  });

  it('lists the template history of a prompt', async () => {
    const history = await listAiPromptTemplateHistory(db, {
      promptKey: 'notes.review',
      tenantId: 'tenant-a',
    });
    const text = formatAiPromptTemplateHistory(history);
    expect(text).toMatch(/h1\s+2\s+0\s+2026-11-08T10:00:00\.000Z/);
    expect(text).toMatch(/h2\s+1\s+0/);

    await promptsHistoryCommand.handler?.(['notes.review'], {
      tenant: 'tenant-b',
      json: true,
    });
    const json = JSON.parse(logs.at(-1) ?? '{}');
    expect(json.tenantId).toBe('tenant-b');
    expect(json.hashes.map((entry: { calls: number }) => entry.calls)).toEqual([
      1,
    ]);
    expect(formatAiPromptTemplateHistory({ ...history, hashes: [] })).toContain(
      '(no calls of notes.review in this window)',
    );
  });
});
