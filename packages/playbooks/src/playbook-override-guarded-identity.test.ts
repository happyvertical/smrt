/**
 * Revision-guarded identity change on PlaybookOverride (#4408).
 *
 * The caller's `expectedUpdatedAt` guards the ORIGINAL row (verified by the
 * delete); the replacement insert must not carry the update guard.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPlaybookCache } from './cache.js';
import { PlaybookOverrideCollection } from './collections/PlaybookOverrideCollection.js';
import { definePlaybook, PlaybookRegistry } from './playbook-registry.js';

const STALE = '2000-01-01T00:00:00.000Z';
const STEPS = [
  {
    kind: 'operation' as const,
    model: '@happyvertical/smrt-commerce:Order',
    action: 'submit',
  },
];

describe('PlaybookOverride guarded identity change (#4408)', () => {
  let db: DatabaseInterface;
  let overrides: PlaybookOverrideCollection;

  beforeEach(async () => {
    setupTestTenancy();
    resetTenancy();
    PlaybookRegistry.clear();
    clearPlaybookCache();
    clearCache();
    setConfig({ packages: { playbooks: { playbooks: {} } } });
    for (const key of ['test.identity.a', 'test.identity.b']) {
      definePlaybook({
        key,
        title: 'Title',
        description: 'Description',
        steps: STEPS,
        editable: { title: true },
      });
    }
    db = await getTestDatabase({ classes: ['PlaybookOverride'] });
    overrides = await PlaybookOverrideCollection.create({ db });
  });

  afterEach(async () => {
    clearPlaybookCache();
    PlaybookRegistry.clear();
    resetTenancy();
    if (typeof (db as any)?.close === 'function') await (db as any).close();
  });

  it('plain guarded save with the current revision succeeds', async () => {
    const created = await overrides.create({
      key: 'test.identity.a',
      title: 'one',
    });
    const row = await overrides.get({ id: created.id }, { cache: false });
    if (!row?.updated_at) throw new Error('expected persisted revision');
    row.title = 'two';
    await row.save({ expectedUpdatedAt: row.updated_at });
    expect((await overrides.get({ id: created.id }))?.title).toBe('two');
  });

  it('identity change with the current revision succeeds', async () => {
    const created = await overrides.create({
      key: 'test.identity.a',
      title: 'moving',
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
    expect(moved[0].title).toBe('moving');
  });

  it('identity change with a stale revision rejects and leaves the row', async () => {
    const created = await overrides.create({
      key: 'test.identity.a',
      title: 'stays',
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
    expect(original[0].title).toBe('stays');
    expect(
      await overrides.list({ where: { key: 'test.identity.b' } }),
    ).toHaveLength(0);
  });
});
