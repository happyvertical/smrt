/**
 * Tests for `smrt ai:transcript` and `ai:usage --with-transcripts` (#4780):
 * the tenant-scope flags, the actor default, the worst-labelled order and the
 * rendering, over core's `listAiTranscripts()` on in-memory SQLite.
 */

import {
  AiUsagePersistenceHandler,
  ensureSystemTables,
  listAiTranscripts,
  recordAiTranscript,
  recordAiUsageOutcome,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aiTranscriptCommand,
  formatAiTranscript,
  formatWorstLabelledTranscripts,
  transcriptActor,
  transcriptScope,
  worstLabelledTranscripts,
} from '../ai-transcript.js';

describe('transcriptScope', () => {
  it('requires --tenant or --all-tenants, never both', () => {
    expect(() => transcriptScope({})).toThrow(/--tenant <id>/);
    expect(() =>
      transcriptScope({ tenant: 't1', 'all-tenants': true }),
    ).toThrow(/not both/);
    expect(transcriptScope({ tenant: 't1' })).toEqual({ tenantId: 't1' });
    expect(transcriptScope({ tenant: 'global' })).toEqual({ tenantId: null });
    expect(transcriptScope({ 'all-tenants': true })).toEqual({
      allowCrossTenant: true,
    });
  });

  it('names the operator for the audit event', () => {
    expect(transcriptActor('ops@example')).toBe('ops@example');
    expect(transcriptActor(undefined)).toMatch(/^cli:/);
  });
});

describe('transcript rendering', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await ensureSystemTables(db, 'sqlite');
    const handler = new AiUsagePersistenceHandler(db);
    for (const [callId, tenantId, minute] of [
      ['call-a', 'tenant-a', 1],
      ['call-b', 'tenant-a', 2],
      ['call-c', 'tenant-a', 3],
    ] as const) {
      const createdAt = new Date(`2026-11-08T10:0${minute}:00Z`);
      await handler.handle({
        provider: 'openai',
        model: 'gpt-test',
        operation: 'message',
        usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
        duration: 12,
        timestamp: createdAt,
        tenantId,
        tags: { callId, promptKey: 'notes.review' },
      });
      await recordAiTranscript(db, {
        callId,
        tenantId,
        promptKey: 'notes.review',
        templateHash: 'h1',
        provider: 'openai',
        model: 'gpt-test',
        operation: 'message',
        className: 'Note',
        request: JSON.stringify({
          messages: [{ role: 'user', content: `question ${callId}` }],
          options: {},
        }),
        response: JSON.stringify({
          messages: [{ role: 'assistant', content: `answer ${callId}` }],
        }),
        toolEvents: null,
        truncated: false,
        bytes: 100,
        createdAt,
      });
    }
    await recordAiUsageOutcome(db, {
      callId: 'call-a',
      label: 'rejected',
      score: 0.2,
      actor: 'reviewer',
    });
    await recordAiUsageOutcome(db, {
      callId: 'call-b',
      label: 'rejected',
      score: 0.05,
      actor: 'reviewer',
    });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('prints one transcript with its usage and labels', async () => {
    const [transcript] = await listAiTranscripts(db, {
      actor: 'test',
      tenantId: 'tenant-a',
      callId: 'call-a',
    });
    if (!transcript) throw new Error('missing transcript');
    const text = formatAiTranscript(transcript);
    expect(text).toContain('Call:      call-a');
    expect(text).toContain('Prompt:    notes.review @ h1');
    expect(text).toContain('Usage:     1 row(s), 10 tokens');
    expect(text).toContain('rejected (0.2) by reviewer');
    expect(text).toContain('[user]\nquestion call-a');
    expect(text).toContain('[assistant]\nanswer call-a');
  });

  it('orders labelled calls worst first and drops unlabelled ones', async () => {
    const labelled = await listAiTranscripts(db, {
      actor: 'test',
      tenantId: 'tenant-a',
      labelled: true,
    });
    expect(labelled.map((row) => row.callId).sort()).toEqual([
      'call-a',
      'call-b',
    ]);
    const worst = worstLabelledTranscripts(labelled, 10);
    expect(worst.map((row) => row.callId)).toEqual(['call-b', 'call-a']);
    const text = formatWorstLabelledTranscripts(worst);
    expect(text).toMatch(/call-b\s+notes\.review\s+openai:gpt-test\s+0\.05/);
    expect(formatWorstLabelledTranscripts([])).toContain(
      '(no labelled transcripts in this window)',
    );
  });

  it('declares its flags', () => {
    expect(aiTranscriptCommand.name).toBe('ai:transcript');
    expect(aiTranscriptCommand.args).toEqual(['<callId>']);
    expect(Object.keys(aiTranscriptCommand.options ?? {})).toEqual([
      'tenant',
      'all-tenants',
      'actor',
      'reason',
      'json',
    ]);
  });
});
