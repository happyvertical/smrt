import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the AI client so the translation job is deterministic — no network,
// no API key, just the canned Spanish translation.
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return {
    ...actual,
    getAI: vi.fn(async () => ({
      message: vi.fn(async () => '{"translation": "Hola, {name}"}'),
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
      ai: { profile: undefined, model: undefined, params: {} },
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
import './translation-job.js';
import type { LanguageTranslationTask } from './translation-job.js';

describe('@happyvertical/smrt-languages — miss → enqueue → run → resolved', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
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
