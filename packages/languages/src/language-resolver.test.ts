import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
