import { EMPTY_APP, type VersionRecord } from '@happyvertical/smrt-app-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../objects/App.ts';
import { closeHost, getHost } from './host.ts';
import { runAs } from './owner.ts';
import { openShell, type ShellHarness } from './test-support.ts';
import { ShellVersionStore } from './version-store.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

const rec = (version: number, parent: number | null): VersionRecord => ({
  version,
  parent,
  author: 'a',
  summary: `v${version}`,
  definition: { ...EMPTY_APP, name: `app ${version}` },
  migration: version ? { steps: [] } : null,
  createdAt: new Date(version * 1000).toISOString(),
});

describe('ShellVersionStore', () => {
  it('round-trips versions, the current pointer and purged markers', async () => {
    const s = new ShellVersionStore(h.db);
    expect(await s.current()).toBeNull();
    expect(await s.maxVersion()).toBe(-1);
    await s.append(rec(0, null));
    await s.append(rec(1, 0));
    await s.append(rec(2, 1));
    await expect(s.append(rec(2, 1))).rejects.toThrow(/already exists/);
    await s.setCurrent(1);
    expect(await s.current()).toBe(1);
    expect(await s.maxVersion()).toBe(2);
    expect(await s.get(2)).toEqual(rec(2, 1));
    expect(await s.get(0)).toEqual(rec(0, null));
    expect(await s.get(9)).toBeNull();
    expect((await s.list()).map((r) => r.version)).toEqual([0, 1, 2]);
    await s.markPurged(1);
    expect((await s.get(1))?.migration).toEqual({ steps: [], purged: true });
    expect((await s.get(2))?.migration?.purged).toBeUndefined();
    // a second store on the same database sees the same state
    const other = new ShellVersionStore(h.db);
    expect(await other.current()).toBe(1);
    expect((await other.appRow()).name).toBe('app 1');
    await expect(s.setCurrent(7)).rejects.toThrow(/not stored/);
  });
});

describe('host restart', () => {
  it('reopens on the stored current version, with the data in app.db', async () => {
    // fresh database: the first store above belongs to a different harness state
    const h2 = await openShell();
    try {
      await runAs(h2.owner, () =>
        App.defineModel('Chore', { title: { type: 'text' } }),
      );
      const host = await getHost();
      await host.create('Chore', { title: 'survives' });
      const version = host.version;
      await closeHost();
      const again = await getHost();
      expect(again).not.toBe(host);
      expect(again.version).toBe(version);
      expect((await again.list('Chore')).map((r) => r.title)).toEqual([
        'survives',
      ]);
      // plain files inside the data root, no symlinks
      const { lstatSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const f of ['app.db', 'snapshots'])
        expect(lstatSync(join(h2.dir, 'user-app', f)).isSymbolicLink()).toBe(
          false,
        );
      expect(lstatSync(join(h2.dir, 'shell.db')).isFile()).toBe(true);
    } finally {
      await h2.close();
    }
  });

  it('refuses reserved model names', async () => {
    const h3 = await openShell();
    try {
      for (const name of ['App', 'approval'])
        await expect(
          runAs(h3.owner, () => App.defineModel(name)),
        ).rejects.toThrow(/reserved/);
    } finally {
      await h3.close();
    }
  });
});
