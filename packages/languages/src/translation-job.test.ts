import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLanguageCache } from './cache.js';
import { LanguageOverrideCollection } from './collections/LanguageOverrideCollection.js';
import { defineLanguageString, LanguageRegistry } from './language-registry.js';
import { enqueueTranslationJob } from './translation-job.js';

describe('@happyvertical/smrt-languages — translation-job dedup', () => {
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

  it('enqueues a single job for repeated misses against the same (key, locale)', async () => {
    defineLanguageString({
      key: 'test.dedup',
      locale: 'en',
      template: 'Hello',
    });

    const first = await enqueueTranslationJob({
      key: 'test.dedup',
      targetLocale: 'es',
      sourceLocale: 'en',
      db,
    });
    const second = await enqueueTranslationJob({
      key: 'test.dedup',
      targetLocale: 'es',
      sourceLocale: 'en',
      db,
    });

    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('duplicate');
    expect(first.id).toBe(second.id);
  });

  it('skips locales outside the configured allowlist', async () => {
    defineLanguageString({
      key: 'test.allowlist',
      locale: 'en',
      template: 'Hello',
    });

    const result = await enqueueTranslationJob({
      key: 'test.allowlist',
      targetLocale: 'ja',
      sourceLocale: 'en',
      db,
    });
    expect(result.status).toBe('skipped');
  });

  it('skips when no source-locale code default is registered', async () => {
    const result = await enqueueTranslationJob({
      key: 'test.unregistered',
      targetLocale: 'es',
      sourceLocale: 'en',
      db,
    });
    expect(result.status).toBe('skipped');
  });

  it('does not overwrite an existing app override on second enqueue when source unchanged', async () => {
    defineLanguageString({
      key: 'test.preserve',
      locale: 'en',
      template: 'Hello',
    });

    const overrides = await LanguageOverrideCollection.create({ db });
    await overrides.create({
      key: 'test.preserve',
      locale: 'es',
      tenantId: null,
      template: 'Hola humana',
      auto_generated: false,
    });

    const result = await enqueueTranslationJob({
      key: 'test.preserve',
      targetLocale: 'es',
      sourceLocale: 'en',
      db,
    });
    // The job is enqueued (resolver may have other reasons to want one), but
    // the handler will skip when it runs because the row is human-edited.
    // Importantly the existing row stays put — verified below.
    expect(['enqueued', 'duplicate']).toContain(result.status);

    const persisted = await overrides.getAppOverride('test.preserve', 'es');
    expect(persisted?.template).toBe('Hola humana');
    expect(persisted?.auto_generated).toBe(false);
  });
});
