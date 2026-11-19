// The desktop (local profile) with the shell models now tenant-scoped: a
// database made before that change keeps working, and the shell works with
// the tenancy interceptor ON (as the local runtime turns it on).
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../objects/App.ts';
import { applyOwnBatch } from './approvals.ts';
import { changesState, flushChecks } from './changes.ts';
import { closeHost, getHost } from './host.ts';
import { runAs } from './owner.ts';
import { prepareShellSchema, TENANT_SCOPED_TABLES } from './schema.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeEach(async () => {
  h = await openShell();
});
afterEach(async () => {
  disableTenancy();
  await h.close();
});

async function rows(sql: string, ...args: unknown[]) {
  const res = (await h.db.query(sql, ...args)) as {
    rows?: Record<string, unknown>[];
  };
  return res.rows ?? [];
}

describe('desktop upgrade', () => {
  it('gives an older database its tenant column and its rows the one tenant', async () => {
    // The app as an older release stored it: rows with no tenant.
    await runAs(h.owner, () =>
      App.defineModel('Chore', { title: { type: 'text' } }),
    );
    for (const table of TENANT_SCOPED_TABLES)
      await h.db.query(`UPDATE ${table} SET tenant_id = NULL`);
    expect(
      (await rows('SELECT tenant_id FROM apps')).every((r) => !r.tenant_id),
    ).toBe(true);
    // And one with no such column at all.
    let dropped = true;
    try {
      await h.db.query('ALTER TABLE assistant_messages DROP COLUMN tenant_id');
    } catch {
      dropped = false; // an index names it: the column test is not possible here
    }

    await prepareShellSchema(h.db);
    await prepareShellSchema(h.db); // idempotent

    const tenantId = h.owner.tenantId;
    for (const table of TENANT_SCOPED_TABLES) {
      if (table === 'assistant_messages' && !dropped) continue;
      expect(
        (await rows(`SELECT DISTINCT tenant_id FROM ${table}`)).map(
          (r) => r.tenant_id,
        ),
        table,
      ).toEqual(
        (await rows(`SELECT 1 FROM ${table}`)).length ? [tenantId] : [],
      );
    }
  });

  it('leaves rows alone when it cannot tell whose they are', async () => {
    await runAs(h.owner, () => App.defineModel('Chore'));
    await h.db.query('UPDATE apps SET tenant_id = NULL');
    await (await TenantCollection.create({ db: h.db }))
      .create({ name: 'Second', slug: 'second' })
      .then((t) => t.save());
    await prepareShellSchema(h.db);
    expect((await rows('SELECT tenant_id FROM apps'))[0].tenant_id).toBeNull();
  });
});

describe('desktop with the tenancy interceptor on', () => {
  it('opens, builds, restarts and keeps its definition under the owner context', async () => {
    enableTenancy();
    await runAs(h.owner, () =>
      App.defineModel('Chore', { title: { type: 'text' } }),
    );
    // Structure waits for the owner's Apply; then live holds it.
    await runAs(h.owner, () => changesState());
    await flushChecks();
    const waiting = await runAs(h.owner, () => changesState());
    await runAs(h.owner, () => applyOwnBatch(waiting.digest));
    await runAs(h.owner, async () =>
      (await getHost()).create('Chore', { title: 'kept' }),
    );
    await closeHost();
    const names = await runAs(h.owner, async () => {
      const host = await getHost();
      return (await host.list('Chore')).map((r) => r.title);
    });
    expect(names).toEqual(['kept']);
    // The rows carry the owner's tenant.
    expect(
      (await rows('SELECT DISTINCT tenant_id FROM apps')).map(
        (r) => r.tenant_id,
      ),
    ).toEqual([h.owner.tenantId]);
    // So do the change batch and card the Apply consumed.
    for (const table of ['change_batches', 'change_cards'])
      expect(
        (await rows(`SELECT DISTINCT tenant_id FROM ${table}`)).map(
          (r) => r.tenant_id,
        ),
        table,
      ).toEqual([h.owner.tenantId]);
    expect(
      (await rows('SELECT tenant_id FROM app_versions')).every(
        (r) => r.tenant_id === h.owner.tenantId,
      ),
    ).toBe(true);
  });
});
