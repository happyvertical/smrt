/**
 * Revision-guarded identity change on PromptOverride (#4408).
 *
 * An identity change deletes the original row and inserts a replacement. The
 * caller's `expectedUpdatedAt` guards the ORIGINAL row (verified by the
 * delete); the replacement is a fresh insert and must not carry the guard.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPromptCache } from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';

const STALE = '2000-01-01T00:00:00.000Z';

describe('PromptOverride guarded identity change (#4408)', () => {
  let db: DatabaseInterface;
  let overrides: PromptOverrideCollection;

  beforeEach(async () => {
    setupTestTenancy();
    resetTenancy();
    PromptRegistry.clear();
    clearPromptCache();
    clearCache();
    setConfig({ packages: { prompts: { profiles: {} } } });
    for (const key of ['test.identity.a', 'test.identity.b']) {
      definePrompt({ key, template: 'Hello', editable: { template: true } });
    }
    db = await getTestDatabase({ classes: ['PromptOverride'] });
    overrides = await PromptOverrideCollection.create({ db });
  });

  afterEach(async () => {
    clearPromptCache();
    PromptRegistry.clear();
    resetTenancy();
    if (typeof (db as any)?.close === 'function') await (db as any).close();
  });

  it('plain guarded save with the current revision succeeds', async () => {
    const created = await overrides.create({
      key: 'test.identity.a',
      template: 'one',
    });
    const row = await overrides.get({ id: created.id }, { cache: false });
    if (!row?.updated_at) throw new Error('expected persisted revision');
    row.template = 'two';
    await row.save({ expectedUpdatedAt: row.updated_at });
    expect((await overrides.get({ id: created.id }))?.template).toBe('two');
  });

  it('identity change with the current revision succeeds', async () => {
    const created = await overrides.create({
      key: 'test.identity.a',
      template: 'moving',
    });
    const row = await overrides.get({ id: created.id }, { cache: false });
    if (!row?.updated_at) throw new Error('expected persisted revision');
    row.key = 'test.identity.b';
    await row.save({ expectedUpdatedAt: row.updated_at });

    expect(
      await overrides.list({ where: { key: 'test.identity.a' } }),
    ).toHaveLength(0);
    const moved = await overrides.list({ where: { key: 'test.identity.b' } });
    expect(moved).toHaveLength(1);
    expect(moved[0].template).toBe('moving');
  });

  it('identity change with a stale revision rejects and leaves the row', async () => {
    const created = await overrides.create({
      key: 'test.identity.a',
      template: 'stays',
    });
    const row = await overrides.get({ id: created.id }, { cache: false });
    if (!row) throw new Error('expected row');
    row.key = 'test.identity.b';
    await expect(row.save({ expectedUpdatedAt: STALE })).rejects.toMatchObject({
      code: 'RUNTIME_REVISION_CONFLICT',
    });

    const original = await overrides.list({
      where: { key: 'test.identity.a' },
    });
    expect(original).toHaveLength(1);
    expect(original[0].template).toBe('stays');
    expect(
      await overrides.list({ where: { key: 'test.identity.b' } }),
    ).toHaveLength(0);
  });
});
