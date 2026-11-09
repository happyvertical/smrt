/**
 * The app's transcript setting through the settings service (#4781): app
 * row only (tenants refused at the service and the model), authorizer
 * first, applied as core's app settings layer in this process, re-applied by
 * the override resolver, env still wins, and usage() transcript counts.
 */
import { randomUUID } from 'node:crypto';
import {
  getAiTranscriptAppSettings,
  getTestDatabase,
  type InferenceConfig,
  type InferenceTranscriptsConfig,
  recordAiTranscript,
  resolveAiTranscriptConfig,
  setAiTranscriptAppSettings,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InferenceOverride } from '../models/InferenceOverride.js';
import {
  APP_INFERENCE_SCOPE_ID,
  createInferenceOverrideResolver,
  InferenceBindingValueError,
  InferenceOverrideAuthorizationError,
  InferenceOverrideService,
  type InferenceOverrideWriteRequest,
  InferenceSettingsService,
  loadInferenceTranscriptSettings,
  TRANSCRIPTS_BINDING,
} from '../server.js';

describe('transcript settings (#4781)', () => {
  let db: DatabaseInterface;
  let transcripts: InferenceTranscriptsConfig | undefined;
  let env: boolean | undefined;
  let requests: InferenceOverrideWriteRequest[];

  /** Core's merge with injectable config and env layers. */
  const merged = (app: InferenceTranscriptsConfig | null) => ({
    ...(transcripts ?? {}),
    ...(app ?? {}),
    ...(env === undefined ? {} : { enabled: env }),
  });

  const service = (authorize?: boolean) =>
    InferenceSettingsService.create(
      { db },
      {
        config: () => ({}) as InferenceConfig,
        transcriptsConfig: merged,
        retention: () => ({ aiTranscripts: { maxAgeDays: 14 } }),
        authorize:
          authorize === undefined
            ? undefined
            : (request) => {
                requests.push(request);
                return authorize;
              },
      },
    );

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['InferenceOverride'] });
    transcripts = { enabled: false, sample: 0.2 };
    env = undefined;
    requests = [];
    setAiTranscriptAppSettings(null);
  });

  afterEach(async () => {
    setAiTranscriptAppSettings(null);
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('reads config, env and retention with no app row', async () => {
    const reader = await service();
    expect(await reader.getTranscriptSettings()).toEqual({
      binding: TRANSCRIPTS_BINDING,
      enabled: false,
      sample: 0.2,
      maxBytes: 65_536,
      supplyingLevel: 'config',
      appValue: null,
      appRevert: { enabled: false, sample: 0.2, maxBytes: 65_536 },
      envEnabled: null,
      retentionDays: 14,
      promptOverrides: [],
    });
    env = true;
    expect(await reader.getTranscriptSettings()).toMatchObject({
      enabled: true,
      supplyingLevel: 'env',
      envEnabled: true,
    });
  });

  it('writes the app row through the authorizer and applies it here', async () => {
    const admin = await service(true);
    await admin.setTranscriptSettings({
      settings: { enabled: true, sample: 0.5, maxBytes: 4096 },
    });
    expect(requests).toEqual([
      {
        operation: 'set',
        binding: 'transcripts',
        scopeType: 'app',
        scopeId: APP_INFERENCE_SCOPE_ID,
        value: { enabled: true, sample: 0.5, maxBytes: 4096 },
      },
    ]);
    expect(getAiTranscriptAppSettings()).toEqual({
      enabled: true,
      sample: 0.5,
      maxBytes: 4096,
    });
    expect(resolveAiTranscriptConfig().enabled).toBe(true);
    expect(await admin.getTranscriptSettings()).toMatchObject({
      enabled: true,
      sample: 0.5,
      maxBytes: 4096,
      supplyingLevel: 'app',
      appValue: { enabled: true, sample: 0.5, maxBytes: 4096 },
      appRevert: { enabled: false, sample: 0.2 },
    });

    await admin.setTranscriptSettings({ settings: null });
    expect(getAiTranscriptAppSettings()).toBeNull();
    expect((await admin.getTranscriptSettings()).appValue).toBeNull();
  });

  it('fails closed without an authorizer and changes nothing', async () => {
    const reader = await service();
    await expect(
      reader.setTranscriptSettings({ settings: { enabled: true } }),
    ).rejects.toBeInstanceOf(InferenceOverrideAuthorizationError);
    const denied = await service(false);
    await expect(
      denied.setTranscriptSettings({ settings: { enabled: true } }),
    ).rejects.toBeInstanceOf(InferenceOverrideAuthorizationError);
    expect(getAiTranscriptAppSettings()).toBeNull();
    expect((await reader.getTranscriptSettings()).appValue).toBeNull();
  });

  it('refuses invalid values and extra members', async () => {
    const admin = await service(true);
    for (const settings of [
      { sample: 2 },
      { maxBytes: 3.5 },
      { enabled: 'yes' },
      { enabled: true, prompts: {} },
      { enabled: true, apiKey: 'sk-x' },
    ]) {
      await expect(
        admin.setTranscriptSettings({ settings: settings as never }),
      ).rejects.toBeInstanceOf(InferenceBindingValueError);
    }
    expect(requests).toEqual([]);
  });

  it('never stores a tenant row', async () => {
    const collection = (await (
      await import('../models/InferenceOverrideCollection.js')
    ).InferenceOverrideCollection.create({ db } as never)) as never;
    const writes = new InferenceOverrideService(collection, () => true);
    await expect(
      writes.setValue(TRANSCRIPTS_BINDING, 'tenant', randomUUID(), {
        enabled: true,
      }),
    ).rejects.toThrow(/app scope only/);
    const row = new InferenceOverride({
      db,
      binding: TRANSCRIPTS_BINDING,
      tenantId: randomUUID(),
      target: JSON.stringify({ enabled: true }),
    });
    await row.initialize();
    await expect(row.save()).rejects.toThrow(/app scope only/);
  });

  it('is re-applied by the override resolver and by the startup loader', async () => {
    const admin = await service(true);
    await admin.setTranscriptSettings({ settings: { enabled: true } });
    setAiTranscriptAppSettings(null);

    const resolver = createInferenceOverrideResolver({ db: { db } });
    await resolver.resolve({ tier: 'good', tenantId: randomUUID() }, {
      config: undefined,
      resolveFromConfig: () => undefined,
    } as never);
    expect(getAiTranscriptAppSettings()).toEqual({ enabled: true });

    setAiTranscriptAppSettings(null);
    expect(await loadInferenceTranscriptSettings({ db: { db } })).toEqual({
      enabled: true,
    });
    expect(getAiTranscriptAppSettings()).toEqual({ enabled: true });
  });

  it('adds per-bucket transcript counts and the fusion/template dimensions', async () => {
    const tenantId = randomUUID();
    await db.query(
      `INSERT INTO _smrt_ai_usage
         (id, provider, model, operation, duration, tenant_id, prompt_key,
          call_id, tags, created_at)
       VALUES ($1,'openai','gpt-4o','chat',1,$2,'p.one','c1',$3,$4)`,
      'u-1',
      tenantId,
      JSON.stringify({ templateHash: 'h1', fusionKey: 'duo' }),
      new Date().toISOString(),
    );
    await recordAiTranscript(db, {
      callId: 'c1',
      tenantId,
      operation: 'chat',
      request: '{}',
      response: '{}',
      toolEvents: null,
      truncated: false,
      bytes: 2,
    });
    const reader = await service();
    const report = await reader.usage({
      by: ['prompt', 'fusion', 'template'],
      tenantId,
      transcripts: true,
    });
    expect(report.buckets).toEqual([
      expect.objectContaining({
        key: { prompt: 'p.one', fusion: 'duo', template: 'h1' },
        transcripts: 1,
      }),
    ]);
  });
});
