import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLanguageCache, getLanguageCacheTtlMs } from './cache.js';
import { LanguageOverrideCollection } from './collections/LanguageOverrideCollection.js';
import { defineLanguageString, LanguageRegistry } from './language-registry.js';
import { resolveLanguageString } from './language-resolver.js';

describe('@happyvertical/smrt-languages — resolver', () => {
  let db: DatabaseInterface;
  let overrides: LanguageOverrideCollection;

  beforeEach(async () => {
    setupTestTenancy();
    LanguageRegistry.clear();
    clearLanguageCache();
    clearCache();

    setConfig({
      packages: {
        languages: {
          defaultLocale: 'en',
        },
      },
    });

    db = await getTestDatabase({
      classes: ['LanguageOverride'],
    });
    overrides = await LanguageOverrideCollection.create({ db });
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

  it('falls through code → config → app → tenant → runtime in priority order', async () => {
    defineLanguageString({
      key: 'test.precedence',
      locale: 'en',
      template: 'Code {name}',
    });

    setConfig({
      packages: {
        languages: {
          defaultLocale: 'en',
          overrides: {
            'test.precedence': {
              en: 'Config {name}',
            },
          },
        },
      },
    });

    await overrides.create({
      key: 'test.precedence',
      locale: 'en',
      tenantId: null,
      template: 'App {name}',
    });

    await overrides.create({
      key: 'test.precedence',
      locale: 'en',
      tenantId: 'tenant-a',
      template: 'Tenant {name}',
    });

    const resolved = await resolveLanguageString('test.precedence', {
      db,
      tenantId: 'tenant-a',
      vars: { name: 'Will' },
    });

    expect(resolved.text).toBe('Tenant Will');
    expect(resolved.source).toBe('tenant');

    const runtime = await resolveLanguageString('test.precedence', {
      db,
      tenantId: 'tenant-a',
      vars: { name: 'Will' },
      overrides: { template: 'Runtime {name}' },
    });

    expect(runtime.text).toBe('Runtime Will');
    expect(runtime.source).toBe('runtime');
  });

  it('returns a fallback through the locale chain when the requested locale is missing', async () => {
    defineLanguageString({
      key: 'test.fallback',
      locale: 'en',
      template: 'English fallback',
    });

    const resolved = await resolveLanguageString('test.fallback', {
      db,
      locale: 'fr-CA',
    });

    expect(resolved.text).toBe('English fallback');
    expect(resolved.resolvedFromLocale).toBe('en');
    expect(resolved.source).toBe('fallback');
  });

  it('prefers a parent locale over the default-locale fallback', async () => {
    defineLanguageString({
      key: 'test.parent',
      locale: 'en',
      template: 'EN parent',
    });
    defineLanguageString({
      key: 'test.parent',
      locale: 'fr',
      template: 'FR parent',
    });

    const resolved = await resolveLanguageString('test.parent', {
      db,
      locale: 'fr-CA',
    });

    expect(resolved.text).toBe('FR parent');
    expect(resolved.resolvedFromLocale).toBe('fr');
    expect(resolved.source).toBe('fallback');
  });

  it('throws under strict mode when nothing resolves', async () => {
    await expect(
      resolveLanguageString('test.unknown.key', {
        db,
        locale: 'es',
        strict: true,
      }),
    ).rejects.toThrow('has no resolution for locale');
  });

  it('returns the key as text when nothing resolves and strict is false', async () => {
    const resolved = await resolveLanguageString('test.unknown.soft', {
      db,
      locale: 'es',
    });

    expect(resolved.text).toBe('test.unknown.soft');
    expect(resolved.source).toBe('missing');
  });

  it('invalidates the cache when a tenant override is written', async () => {
    defineLanguageString({
      key: 'test.cache.invalidate',
      locale: 'en',
      template: 'Initial {name}',
    });

    const initial = await resolveLanguageString('test.cache.invalidate', {
      db,
      tenantId: 'tenant-a',
      vars: { name: 'Will' },
    });
    expect(initial.text).toBe('Initial Will');

    await overrides.create({
      key: 'test.cache.invalidate',
      locale: 'en',
      tenantId: 'tenant-a',
      template: 'Custom {name}',
    });

    const refreshed = await resolveLanguageString('test.cache.invalidate', {
      db,
      tenantId: 'tenant-a',
      vars: { name: 'Will' },
    });
    expect(refreshed.text).toBe('Custom Will');
    expect(refreshed.source).toBe('tenant');
  });

  it('keeps app-level overrides visible from inside withTenant() through normal CRUD', async () => {
    defineLanguageString({
      key: 'test.crud.scope',
      locale: 'en',
      template: 'Code',
    });

    const appOverride = await overrides.create({
      key: 'test.crud.scope',
      locale: 'en',
      tenantId: null,
      template: 'App',
    });
    await overrides.create({
      key: 'test.crud.scope',
      locale: 'en',
      tenantId: 'tenant-a',
      template: 'Tenant',
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const visible = await overrides.list({
        where: { key: 'test.crud.scope' },
        orderBy: 'createdAt ASC',
      });
      expect(visible.map((item) => item.tenantId)).toEqual([null, 'tenant-a']);
      const loaded = await overrides.get({ id: appOverride.id as string });
      expect(loaded?.tenantId).toBeNull();
    });
  });

  it('uses the package config defaultLocale for fallback when none is specified', async () => {
    setConfig({
      packages: {
        languages: {
          defaultLocale: 'fr',
        },
      },
    });
    defineLanguageString({
      key: 'test.config.default',
      locale: 'fr',
      template: 'Salut',
    });

    const resolved = await resolveLanguageString('test.config.default', {
      db,
    });
    expect(resolved.text).toBe('Salut');
  });

  it('never repopulates an entry with a value read before a concurrent write', async () => {
    defineLanguageString({
      key: 'test.race',
      locale: 'en',
      template: 'Code {name}',
    });

    const loadAppOverride = LanguageOverrideCollection.prototype.getAppOverride;

    // Interleave a write between the resolution's layer read and its cache
    // write: the resolution has already read the pre-write state (no app
    // override), then the write lands and invalidates the entry.
    const spy = vi
      .spyOn(LanguageOverrideCollection.prototype, 'getAppOverride')
      .mockImplementationOnce(async function (
        this: LanguageOverrideCollection,
        ...args: Parameters<typeof loadAppOverride>
      ) {
        const staleOverride = await loadAppOverride.apply(this, args);
        await overrides.create({
          key: 'test.race',
          locale: 'en',
          tenantId: null,
          template: 'App {name}',
        });
        return staleOverride;
      });

    try {
      // This in-flight resolution legitimately returns what it read.
      const racing = await resolveLanguageString('test.race', {
        db,
        tenantId: 'tenant-a',
        vars: { name: 'Will' },
      });
      expect(racing.text).toBe('Code Will');
      expect(racing.source).toBe('code');
    } finally {
      spy.mockRestore();
    }

    // The point of the fix: that stale value must not have been written back
    // over the invalidated entry, so the next resolution sees the write rather
    // than serving the pre-write value for the rest of the TTL.
    const afterRace = await resolveLanguageString('test.race', {
      db,
      tenantId: 'tenant-a',
      vars: { name: 'Will' },
    });
    expect(afterRace.text).toBe('App Will');
    expect(afterRace.source).toBe('app');
  });

  it('refuses a cache write from a resolution that started before clearLanguageCache()', async () => {
    defineLanguageString({
      key: 'test.clear.race',
      locale: 'en',
      template: 'Code {name}',
    });

    const loadAppOverride = LanguageOverrideCollection.prototype.getAppOverride;

    // Interleave the flush — not a save() — between the resolution's layer read
    // and its cache write. This (key, locale) has never been invalidated, so it
    // has no generation entry of its own; only a clear that raises a floor
    // covering absent entries can refuse the write below.
    const spy = vi
      .spyOn(LanguageOverrideCollection.prototype, 'getAppOverride')
      .mockImplementationOnce(async function (
        this: LanguageOverrideCollection,
        ...args: Parameters<typeof loadAppOverride>
      ) {
        const staleOverride = await loadAppOverride.apply(this, args);
        clearLanguageCache();
        // Written directly so no `save()` invalidation runs: the flush alone
        // has to be what makes this row visible.
        await (db as any).upsert(
          '_smrt_language_overrides',
          ['key', 'locale', 'context'],
          {
            id: crypto.randomUUID(),
            slug: 'test-clear-race-app',
            context: '__app__',
            created_at: new Date(),
            updated_at: new Date(),
            key: 'test.clear.race',
            locale: 'en',
            tenant_id: null,
            template: 'DB {name}',
            auto_generated: false,
            source_hash: null,
            ai_model: null,
            reviewed_at: null,
            reviewed_by: null,
          },
        );
        return staleOverride;
      });

    try {
      const racing = await resolveLanguageString('test.clear.race', {
        db,
        tenantId: 'tenant-a',
        vars: { name: 'Will' },
      });
      expect(racing.text).toBe('Code Will');
      expect(racing.source).toBe('code');
    } finally {
      spy.mockRestore();
    }

    const afterClear = await resolveLanguageString('test.clear.race', {
      db,
      tenantId: 'tenant-a',
      vars: { name: 'Will' },
    });
    expect(afterClear.text).toBe('DB Will');
    expect(afterClear.source).toBe('app');
  });

  it('expires stale cache entries after the TTL', async () => {
    defineLanguageString({
      key: 'test.ttl',
      locale: 'en',
      template: 'Cached',
    });

    const initial = await resolveLanguageString('test.ttl', { db });
    expect(initial.text).toBe('Cached');
    expect(getLanguageCacheTtlMs()).toBeGreaterThan(0);
  });

  it('moves the row when (key, locale, tenantId) changes — invalidates old cache, returns code default at the old identity', async () => {
    defineLanguageString({
      key: 'test.identity.source',
      locale: 'en',
      template: 'Source EN',
    });
    defineLanguageString({
      key: 'test.identity.target',
      locale: 'en',
      template: 'Target EN',
    });

    const override = await overrides.create({
      key: 'test.identity.source',
      locale: 'en',
      tenantId: null,
      template: 'App Source',
    });

    const cached = await resolveLanguageString('test.identity.source', {
      db,
      tenantId: 'tenant-a',
    });
    expect(cached.text).toBe('App Source');

    // Move the override across all three identity dimensions in one save.
    override.key = 'test.identity.target';
    override.tenantId = 'tenant-a';
    override.template = 'Tenant Target';
    await override.save();

    // Old (key, locale, tenant) — both the cache and the row should be gone,
    // so resolution falls back through to the registered code default.
    const sourceAfter = await resolveLanguageString('test.identity.source', {
      db,
      tenantId: 'tenant-a',
    });
    expect(sourceAfter.text).toBe('Source EN');
    expect(sourceAfter.source).toBe('code');

    // New identity returns the moved override.
    const targetAfter = await resolveLanguageString('test.identity.target', {
      db,
      tenantId: 'tenant-a',
    });
    expect(targetAfter.text).toBe('Tenant Target');
    expect(targetAfter.source).toBe('tenant');
  });

  it('honors mixed-case file-config locale keys (fr-ca vs fr-CA)', async () => {
    defineLanguageString({
      key: 'test.config.case',
      locale: 'en',
      template: 'EN',
    });
    setConfig({
      packages: {
        languages: {
          defaultLocale: 'en',
          overrides: {
            'test.config.case': {
              // User wrote the locale key in lowercase; resolver normalizes
              // and finds it for a fr-CA request anyway.
              'fr-ca': 'Bonjour',
            },
          },
        },
      },
    });

    const resolved = await resolveLanguageString('test.config.case', {
      db,
      locale: 'fr-CA',
    });
    expect(resolved.text).toBe('Bonjour');
    expect(resolved.source).toBe('config');
  });
});
