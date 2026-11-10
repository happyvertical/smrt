import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  getTestDatabase,
  ObjectRegistry,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the AI client so the translation job is deterministic — no network,
// no API key, just the canned Spanish translation.
const { translationMessage, PROMPT_USAGE_TAGS } = vi.hoisted(() => ({
  translationMessage: vi.fn(
    async (_prompt: string, _options?: Record<string, unknown>) =>
      '{"translation": "Hola, {name}"}',
  ),
  // What resolvePrompt() attaches (#4751); the job must forward them.
  PROMPT_USAGE_TAGS: {
    promptKey: 'smrt-languages.translation',
    promptLayer: 'default',
    templateHash: '0123456789ab',
  },
}));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return {
    ...actual,
    getAI: vi.fn(async () => ({
      message: translationMessage,
    })),
  };
});

// Mock the prompts resolver so the integration test doesn't have to
// provision `_smrt_prompt_overrides` for an external package whose schema
// generation isn't reachable through the local vitest manifest. Production
// callers still get the full smrt-prompts override pipeline; the unit-level
// behavior of `resolvePrompt(db: ...)` is exercised by the prompts package's
// own test suite.
vi.mock('@happyvertical/smrt-prompts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-prompts')>();
  return {
    ...actual,
    resolvePrompt: vi.fn(async () => ({
      key: 'smrt-languages.translation',
      template: 'translate {template} to {targetLocale}',
      text: 'translate Hello, {name} to es',
      ai: {
        profile: undefined,
        model: undefined,
        params: {},
        usageTags: PROMPT_USAGE_TAGS,
      },
    })),
  };
});

import { clearLanguageCache } from './cache.js';
import { LanguageOverrideCollection } from './collections/LanguageOverrideCollection.js';
import { defineLanguageString, LanguageRegistry } from './language-registry.js';
import { resolveLanguageString } from './language-resolver.js';
// Side-effect import: registers `LanguageTranslationTask` with the
// ObjectRegistry so the test can pull a constructor from
// `ObjectRegistry.getClass(...)` and exercise the runner contract.
import './jobs/translation-job.js';
import type { LanguageTranslationTask } from './jobs/translation-job.js';

describe('@happyvertical/smrt-languages — miss → enqueue → run → resolved', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    translationMessage.mockClear();
    setupTestTenancy();
    LanguageRegistry.clear();
    clearLanguageCache();
    clearCache();

    setConfig({
      packages: {
        languages: {
          defaultLocale: 'en',
          supportedLocales: ['en', 'es', 'fr'],
        },
      },
    });

    db = await getTestDatabase({
      classes: ['LanguageOverride', 'SmrtJob', 'LanguageTranslationTask'],
    });
  });

  afterEach(async () => {
    clearLanguageCache();
    LanguageRegistry.clear();
    clearCache();
    resetTenancy();
    if (typeof (db as any)?.close === 'function') {
      await (db as any).close();
    }
  });

  it('returns the fallback then writes a translated app override after the job runs', async () => {
    defineLanguageString({
      key: 'integration.greeting',
      locale: 'en',
      template: 'Hello, {name}',
    });

    // First request in es: miss → fallback to en, enqueue translation job.
    const fallback = await resolveLanguageString('integration.greeting', {
      db,
      locale: 'es',
      vars: { name: 'Will' },
    });
    expect(fallback.text).toBe('Hello, Will');
    expect(fallback.source).toBe('fallback');
    expect(fallback.resolvedFromLocale).toBe('en');

    // Verify a job was enqueued for (key, es).
    const overrides = await LanguageOverrideCollection.create({ db });
    const beforeRun = await overrides.getAppOverride(
      'integration.greeting',
      'es',
    );
    expect(beforeRun).toBeNull();

    // Run the job by invoking the registered task class directly — same
    // contract the runner uses (ObjectRegistry → instance.execute(args)).
    const taskEntry = ObjectRegistry.getClass('LanguageTranslationTask');
    expect(taskEntry).toBeDefined();
    const TaskClass = taskEntry?.constructor as new (
      opts: Record<string, unknown>,
    ) => LanguageTranslationTask;
    const task = new TaskClass({ db });
    await task.initialize();
    const definition = LanguageRegistry.get('integration.greeting', 'en');
    const result = await task.execute({
      key: 'integration.greeting',
      sourceLocale: 'en',
      sourceTemplate: definition?.template ?? '',
      sourceHash: definition?.sourceHash ?? '',
      targetLocale: 'es',
    });
    expect(result.template).toBe('Hola, {name}');
    // The resolved prompt's usage tags reach ai.message() (#4751).
    expect(translationMessage).toHaveBeenCalledTimes(1);
    expect(translationMessage.mock.calls[0][1]).toMatchObject({
      usageTags: PROMPT_USAGE_TAGS,
    });

    // The translation job should have written an app-level override.
    const written = await overrides.getAppOverride(
      'integration.greeting',
      'es',
    );
    expect(written).not.toBeNull();
    expect(written?.template).toBe('Hola, {name}');
    expect(written?.auto_generated).toBe(true);
    expect(written?.source_hash).toBe(definition?.sourceHash);

    // Subsequent es resolves should now hit the auto-generated app row.
    // Clear the cache so we read through to the override row.
    clearLanguageCache();
    const after = await resolveLanguageString('integration.greeting', {
      db,
      locale: 'es',
      vars: { name: 'Will' },
    });
    expect(after.text).toBe('Hola, Will');
    expect(after.source).toBe('app');
    expect(after.resolvedFromLocale).toBe('es');
  });

  it('rejects JSON responses missing the translation field instead of persisting the wrong shape', async () => {
    const ai = await import('@happyvertical/ai');
    // Re-stub the mock: valid JSON, wrong shape — the handler must NOT fall
    // through to the bare-string path and persist the whole blob.
    const getAiSpy = vi.spyOn(ai, 'getAI').mockResolvedValue({
      message: vi.fn(async () => '{"text": "Hola"}'),
    } as any);

    defineLanguageString({
      key: 'integration.shape',
      locale: 'en',
      template: 'Hello',
    });

    const taskEntry = ObjectRegistry.getClass('LanguageTranslationTask');
    const TaskClass = taskEntry?.constructor as new (
      opts: Record<string, unknown>,
    ) => LanguageTranslationTask;
    const task = new TaskClass({ db });
    await task.initialize();

    const definition = LanguageRegistry.get('integration.shape', 'en');
    await expect(
      task.execute({
        key: 'integration.shape',
        sourceLocale: 'en',
        sourceTemplate: definition?.template ?? '',
        sourceHash: definition?.sourceHash ?? '',
        targetLocale: 'es',
      }),
    ).rejects.toThrow('returned no usable translation');

    const overrides = await LanguageOverrideCollection.create({ db });
    const persisted = await overrides.getAppOverride('integration.shape', 'es');
    expect(persisted).toBeNull();

    getAiSpy.mockRestore();
  });

  it('takes a stored tenant binding and records attributed usage (#4756)', async () => {
    const ai = await import('@happyvertical/ai');
    const configs: Record<string, unknown>[] = [];
    const getAiSpy = vi
      .spyOn(ai, 'getAI')
      .mockImplementation(async (config: unknown) => {
        configs.push(config as Record<string, unknown>);
        return { message: translationMessage } as any;
      });
    const requests: unknown[] = [];
    setInferenceResolver({
      resolve: (request) => {
        requests.push(request);
        return {
          tierResolved: request.tier === 'auto' ? 'good' : request.tier,
          target: {
            provider: 'openai',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'sk-tenant-binding',
            model: 'tenant/model',
            source: 'byo',
          },
          via: 'resolver',
        };
      },
    });
    try {
      defineLanguageString({
        key: 'integration.binding',
        locale: 'en',
        template: 'Hello, {name}',
      });
      const TaskClass = ObjectRegistry.getClass('LanguageTranslationTask')
        ?.constructor as new (
        opts: Record<string, unknown>,
      ) => LanguageTranslationTask;
      const task = new TaskClass({ db });
      await task.initialize();
      const definition = LanguageRegistry.get('integration.binding', 'en');
      await task.execute({
        key: 'integration.binding',
        sourceLocale: 'en',
        sourceTemplate: definition?.template ?? '',
        sourceHash: definition?.sourceHash ?? '',
        targetLocale: 'es',
        tenantId: 'tenant-binding',
      });

      expect(requests[0]).toMatchObject({
        tenantId: 'tenant-binding',
        promptKey: 'smrt-languages.translation',
      });
      expect(configs[0]).toMatchObject({
        provider: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'tenant/model',
      });
      expect(translationMessage.mock.calls[0][1]).toMatchObject({
        model: 'tenant/model',
        usageTags: PROMPT_USAGE_TAGS,
      });

      const onUsage = configs[0].onUsage as (event: unknown) => Promise<void>;
      await onUsage({
        provider: 'openai',
        model: 'tenant/model',
        operation: 'message',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        tags: PROMPT_USAGE_TAGS,
      });
      const rows = await task.listAiUsage({
        className: 'LanguageTranslationTask',
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: 'tenant-binding',
        model: 'tenant/model',
        tags: expect.objectContaining({
          source: 'byo',
          tierResolved: 'good',
          promptKey: 'smrt-languages.translation',
        }),
      });
      expect(JSON.stringify(rows[0])).not.toContain('sk-tenant-binding');
    } finally {
      setInferenceResolver(undefined);
      getAiSpy.mockRestore();
    }
  });

  it('never overwrites a human-edited row even when the source changes', async () => {
    defineLanguageString({
      key: 'integration.preserve',
      locale: 'en',
      template: 'Original',
    });

    const overrides = await LanguageOverrideCollection.create({ db });
    await overrides.create({
      key: 'integration.preserve',
      locale: 'es',
      tenantId: null,
      template: 'Original-ES (curado)',
      auto_generated: false,
    });

    const taskEntry = ObjectRegistry.getClass('LanguageTranslationTask');
    const TaskClass = taskEntry?.constructor as new (
      opts: Record<string, unknown>,
    ) => LanguageTranslationTask;
    const task = new TaskClass({ db });
    await task.initialize();

    // Even with a fresh source-hash the handler must skip and leave the
    // human-edited row untouched.
    const result = await task.execute({
      key: 'integration.preserve',
      sourceLocale: 'en',
      sourceTemplate: 'Updated source',
      sourceHash: 'sha256:newhash',
      targetLocale: 'es',
    });
    expect(result.skipped).toBe('stale');

    const persisted = await overrides.getAppOverride(
      'integration.preserve',
      'es',
    );
    expect(persisted?.template).toBe('Original-ES (curado)');
    expect(persisted?.auto_generated).toBe(false);
  });
});
