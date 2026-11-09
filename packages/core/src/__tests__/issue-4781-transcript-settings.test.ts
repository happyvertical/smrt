/**
 * The transcript settings layer and the Usage tab's transcript counts
 * (#4781): an app-level settings layer sits between `config()` and the
 * environment, and `reportAiUsage({ transcripts: true })` counts calls with
 * a stored transcript per bucket, within the report's tenant, reading ids
 * only. `template` groups by the `templateHash` tag.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAiTranscriptAppSettings,
  resolveAiTranscriptConfig,
  setAiTranscriptAppSettings,
} from '../ai-transcripts.js';
import { config } from '../config.js';
import { getInferenceTranscriptsConfig } from '../inference.js';
import { recordAiTranscript } from '../system/ai-transcripts.js';
import { reportAiUsage } from '../system/ai-usage-observability.js';
import { getTestDatabase } from '../testing/database';

const ENV = 'SMRT_INFERENCE_TRANSCRIPTS';

describe('transcript app settings layer (#4781)', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
    config.reset();
    clearRuntimeConfig();
    setAiTranscriptAppSettings(null);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    config.reset();
    clearRuntimeConfig();
    setAiTranscriptAppSettings(null);
  });

  it('layers over config() and under the environment', () => {
    config({
      inference: {
        transcripts: { enabled: false, sample: 0.2, maxBytes: 9000 },
      },
    } as never);
    expect(resolveAiTranscriptConfig().enabled).toBe(false);

    setAiTranscriptAppSettings({ enabled: true, sample: 0.5 });
    expect(resolveAiTranscriptConfig()).toMatchObject({
      enabled: true,
      sample: 0.5,
      maxBytes: 9000,
    });

    process.env[ENV] = '0';
    expect(resolveAiTranscriptConfig().enabled).toBe(false);
    expect(getInferenceTranscriptsConfig({ enabled: true })?.enabled).toBe(
      false,
    );

    setAiTranscriptAppSettings(null);
    delete process.env[ENV];
    expect(resolveAiTranscriptConfig().sample).toBe(0.2);
  });

  it('keeps prompt sampling from config', () => {
    config({
      inference: {
        transcripts: { prompts: { 'a.key': { sample: 1 } } },
      },
    } as never);
    setAiTranscriptAppSettings({ enabled: true, sample: 0 });
    expect(resolveAiTranscriptConfig().prompts).toEqual({
      'a.key': { sample: 1 },
    });
  });

  it('refuses invalid values and prompt maps before changing anything', () => {
    setAiTranscriptAppSettings({ enabled: true });
    expect(() => setAiTranscriptAppSettings({ sample: 2 })).toThrow(/sample/);
    expect(() =>
      setAiTranscriptAppSettings({
        prompts: {},
      } as never),
    ).toThrow(/enabled, sample and maxBytes only/);
    expect(getAiTranscriptAppSettings()).toEqual({ enabled: true });
  });

  it('returns copies, so callers cannot mutate the layer', () => {
    setAiTranscriptAppSettings({ enabled: true });
    const copy = getAiTranscriptAppSettings();
    if (copy) copy.enabled = false;
    expect(getAiTranscriptAppSettings()).toEqual({ enabled: true });
  });
});

describe('reportAiUsage transcript counts (#4781)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: [] });
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  let seq = 0;
  async function usage(row: {
    callId?: string | null;
    tenantId?: string | null;
    promptKey?: string | null;
    templateHash?: string;
    operation?: string;
  }) {
    seq += 1;
    await db.query(
      `INSERT INTO _smrt_ai_usage
         (id, provider, model, operation, prompt_tokens, completion_tokens,
          total_tokens, estimated_cost, duration, tenant_id, prompt_key,
          call_id, tags, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      `u-${String(seq).padStart(4, '0')}`,
      'openai',
      'gpt-4o',
      row.operation ?? 'chat',
      1,
      1,
      2,
      null,
      5,
      row.tenantId ?? null,
      row.promptKey ?? null,
      row.callId ?? null,
      JSON.stringify(
        row.templateHash ? { templateHash: row.templateHash } : {},
      ),
      new Date().toISOString(),
    );
  }

  async function transcript(callId: string, tenantId: string | null) {
    await recordAiTranscript(db, {
      callId,
      tenantId,
      promptKey: 'p.one',
      operation: 'chat',
      request: '{"messages":[{"role":"user","content":"SECRET-CONTENT"}]}',
      response: '{"messages":[]}',
      toolEvents: null,
      truncated: false,
      bytes: 10,
    });
  }

  it('counts each transcribed call once per bucket, inside the tenant', async () => {
    // Call c1 has two usage rows (a chain): one transcript, counted once.
    await usage({ callId: 'c1', tenantId: 't1', promptKey: 'p.one' });
    await usage({ callId: 'c1', tenantId: 't1', promptKey: 'p.one' });
    await usage({ callId: 'c2', tenantId: 't1', promptKey: 'p.one' });
    await usage({ callId: 'c3', tenantId: 't1', promptKey: 'p.two' });
    await usage({ callId: null, tenantId: 't1', promptKey: 'p.two' });
    // Another tenant reuses call id c3 and stores a transcript for it.
    await usage({ callId: 'c3', tenantId: 't2', promptKey: 'p.two' });
    await transcript('c1', 't1');
    await transcript('c3', 't2');

    const report = await reportAiUsage(db, {
      by: ['prompt'],
      tenantId: 't1',
      transcripts: true,
    });
    const byPrompt = Object.fromEntries(
      report.buckets.map((bucket) => [bucket.key.prompt, bucket.transcripts]),
    );
    expect(byPrompt).toEqual({ 'p.one': 1, 'p.two': 0 });
    expect(report.totals.transcripts).toBe(1);

    const all = await reportAiUsage(db, {
      by: ['tenant'],
      transcripts: true,
    });
    expect(
      Object.fromEntries(
        all.buckets.map((bucket) => [bucket.key.tenant, bucket.transcripts]),
      ),
    ).toEqual({ t1: 1, t2: 1 });
    expect(all.totals.transcripts).toBe(2);
  });

  it('leaves the field out unless asked', async () => {
    await usage({ callId: 'c1', tenantId: 't1', promptKey: 'p.one' });
    await transcript('c1', 't1');
    const report = await reportAiUsage(db, { by: ['prompt'] });
    expect(report.totals).not.toHaveProperty('transcripts');
    expect(report.buckets[0]).not.toHaveProperty('transcripts');
  });

  it('never counts a blocked row and never returns content', async () => {
    await usage({ callId: 'c1', tenantId: null, operation: 'blocked' });
    await transcript('c1', null);
    const report = await reportAiUsage(db, {
      by: ['prompt'],
      tenantId: null,
      transcripts: true,
    });
    expect(report.totals.transcripts).toBe(0);
    expect(JSON.stringify(report)).not.toContain('SECRET-CONTENT');
  });

  it('groups by template hash', async () => {
    await usage({ templateHash: 'h1', promptKey: 'p.one' });
    await usage({ templateHash: 'h1', promptKey: 'p.one' });
    await usage({ promptKey: 'p.one' });
    const report = await reportAiUsage(db, { by: ['template'] });
    expect(
      Object.fromEntries(
        report.buckets.map((bucket) => [
          String(bucket.key.template),
          bucket.calls,
        ]),
      ),
    ).toEqual({ h1: 2, null: 1 });
  });
});
