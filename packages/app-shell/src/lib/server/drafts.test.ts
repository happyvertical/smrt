// Draft then publish, the shell's half: tables and stores, the lifecycle
// service, restart recovery with a draft open, and the publish / discard
// approvals. In-process SQLite, real workers, no network.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Command,
  EMPTY_APP,
  type VersionRecord,
} from '../../engine/index.ts';
import { hostOwner } from '../../test/engine-principal.ts';
import { App } from '../objects/App.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import { AppDraftVersionCollection } from '../objects/AppDraftVersion.ts';
import { type Approval, ApprovalCollection } from '../objects/Approval.ts';
import { AppVersionCollection } from '../objects/AppVersion.ts';
import { isPending, runCommand } from './builder.ts';
import {
  describeCopy,
  discardNow,
  draftInfo,
  historyFor,
  previewDraft,
  startDraft,
} from './drafts.ts';
import { type ShellEvent, subscribe } from './events.ts';
import {
  closeHost,
  DRAFT_DIRNAME,
  getDraftSlot,
  getHost,
  hostFor,
} from './host.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';
import { ShellVersionStore } from './version-store.ts';

let h: ShellHarness;
const events: ShellEvent[] = [];
let off = () => {};
beforeAll(async () => {
  h = await openShell();
  off = subscribe((e) => events.push(e));
  await (await getHost()).execute(
    { type: 'defineModel', name: 'Chore', fields: { title: { type: 'text' } } },
    { author: h.owner.id, approved: true },
  );
  await (await getHost()).create(hostOwner(await getHost()), 'Chore', {
    title: 'live-1',
  });
});
afterAll(async () => {
  off();
  await h.close();
});

const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);
const titles = async (target: 'live' | 'draft') =>
  (
    await (
      await hostFor(target)
    ).list(hostOwner(await hostFor(target)), 'Chore')
  )
    .map((r) => String(r.title))
    .sort();
const decide = async (approvalId: string, approve: boolean) => {
  const row = (await (
    await ApprovalCollection.create({ db: h.db })
  ).get(approvalId)) as Approval;
  return asOwner(() => row.decide(approve));
};
async function ensureNoDraft() {
  if (await getDraftSlot()) await discardNow();
}
const draftRow = async (id: string) =>
  (await (await AppDraftCollection.create({ db: h.db })).get(id)) ?? null;

describe('draft tables and version stores', () => {
  it('the shell schema created the two new tables', async () => {
    for (const table of ['app_drafts', 'app_draft_versions']) {
      const res = (await h.db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      )) as { rows?: unknown[] } | unknown[];
      expect((Array.isArray(res) ? res : (res.rows ?? [])).length).toBe(1);
    }
  });

  it('commit appends the versions and moves the pointer in ONE transaction', async () => {
    const store = new ShellVersionStore(h.db);
    const base = (await store.current()) as number;
    const rec = (version: number, parent: number): VersionRecord => ({
      version,
      parent,
      author: 'test',
      summary: `c${version}`,
      definition: { ...EMPTY_APP, name: 'committed' },
      migration: null,
      createdAt: new Date().toISOString(),
    });
    const max = await store.maxVersion();
    // The second record repeats the first one's number: the whole commit fails.
    await expect(
      store.commit([rec(max + 1, base), rec(max + 1, max + 1)], max + 1),
    ).rejects.toThrow(/already exists/);
    expect(await store.get(max + 1)).toBeNull(); // the first insert rolled back
    expect(await store.current()).toBe(base);
    expect(await store.maxVersion()).toBe(max);
    // A target that is not stored fails the commit after the inserts: also none.
    await expect(store.commit([rec(max + 1, base)], max + 9)).rejects.toThrow(
      /not stored/,
    );
    expect(await store.get(max + 1)).toBeNull();
    expect(await store.current()).toBe(base);
    expect(
      (
        await (
          await AppVersionCollection.create({ db: h.db })
        ).list({
          limit: 1000,
        })
      ).length,
    ).toBe(max + 1);
  });
});

describe('starting a draft', () => {
  it('copies live, freezes live structure, keeps live records working', async () => {
    const live = await getHost();
    const before = live.version;
    const started = await startDraft('  Spring   cleanup ', h.owner.id);
    expect(started).toMatchObject({
      name: 'Spring cleanup',
      status: 'open',
      baseVersion: before,
      version: before,
      changes: 0,
      liveVersion: before,
      liveFrozen: true,
      publishable: true,
      problem: null,
      recovery: 'none',
    });
    expect(live.frozen).toBe(true);
    // the copy has live's records at the time of the fork
    expect(await titles('draft')).toEqual(['live-1']);
    await expect(startDraft('again', h.owner.id)).rejects.toThrow(
      /already open \("Spring cleanup"\)/,
    );
    expect(
      events.some((e) => e.type === 'draft' && e.status === 'started'),
    ).toBe(true);
    const row = await draftRow(started.id);
    expect(row?.status).toBe('open');
    expect(Number(row?.baseVersion)).toBe(before);
  });

  it('builds in the draft host without approvals; the live definition is untouched', async () => {
    const live = await getHost();
    const liveVersion = live.version;
    const draft = await hostFor('draft');
    const run = (command: Command) =>
      draft.execute(command, { author: h.owner.id });
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'points',
      definition: { type: 'text' },
    });
    await run({
      type: 'defineModel',
      name: 'Extra',
      fields: { note: { type: 'text' } },
    });
    // a risky change in the draft is applied (autoApprove), never an Approval
    await run({ type: 'removeField', model: 'Chore', field: 'points' });
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'points',
      definition: { type: 'text' },
    });
    expect(live.version).toBe(liveVersion);
    const liveDescribed = await describeCopy('live');
    expect(liveDescribed.mode).toBe('live');
    expect(liveDescribed.frozen).toBe(true);
    expect(Object.keys(liveDescribed.models)).not.toContain('Extra');
    const draftDescribed = await describeCopy('draft');
    expect(draftDescribed.mode).toBe('draft');
    expect(Object.keys(draftDescribed.models)).toContain('Extra');
    expect((await draftInfo())?.changes).toBe(4);
  });

  it('draft history leaves out the live base version', async () => {
    const info = await draftInfo();
    const versions = await historyFor('draft');
    expect(versions.map((v) => v.version)).not.toContain(info?.baseVersion);
    expect(versions.length).toBe(4);
    expect(versions.every((v) => v.publish === null)).toBe(true);
  });

  it('records are separate: a live write is not in the draft and the reverse', async () => {
    await (await hostFor('live')).create(
      hostOwner(await hostFor('live')),
      'Chore',
      { title: 'live-2' },
    );
    await (await hostFor('draft')).create(
      hostOwner(await hostFor('draft')),
      'Chore',
      { title: 'draft-1' },
    );
    expect(await titles('live')).toEqual(['live-1', 'live-2']);
    expect(await titles('draft')).toEqual(['draft-1', 'live-1']);
    // the events say which copy changed
    const changed = events.filter((e) => e.type === 'changed');
    expect(
      changed.some((e) => e.type === 'changed' && e.target === 'draft'),
    ).toBe(true);
    const records = events.filter((e) => e.type === 'records');
    expect(
      records.some((e) => e.type === 'records' && e.target === 'live'),
    ).toBe(true);
    expect(
      records.some((e) => e.type === 'records' && e.target === 'draft'),
    ).toBe(true);
  });

  it('the draft host is reachable only when the request names the draft', async () => {
    const live = await hostFor('live');
    const draft = await hostFor('draft');
    expect(live).toBe(await getHost());
    expect(draft).not.toBe(live);
    expect(draft.draft).not.toBeNull();
    expect(live.draft).toBeNull();
  });
});

describe('restart with a draft open', () => {
  it('restores frozen live and the draft, with its changes and records', async () => {
    const liveVersion = (await getHost()).version;
    const changes = (await draftInfo())?.changes;
    await closeHost();
    const live = await getHost();
    expect(live.frozen).toBe(true);
    expect(live.version).toBe(liveVersion);
    expect(await draftInfo()).toMatchObject({
      name: 'Spring cleanup',
      changes,
      liveFrozen: true,
      publishable: true,
      recovery: 'none',
    });
    expect(Object.keys((await describeCopy('draft')).models)).toContain(
      'Extra',
    );
    expect(await titles('draft')).toEqual(['draft-1', 'live-1']);
    expect(await titles('live')).toEqual(['live-1', 'live-2']);
    // autoApprove is back on the reopened draft: a risky change just applies
    const draft = await hostFor('draft');
    await draft.execute(
      { type: 'defineModel', name: 'Scratch', fields: {} },
      { author: h.owner.id },
    );
    await draft.execute(
      { type: 'removeModel', model: 'Scratch' },
      { author: h.owner.id },
    );
  });
});

describe('an unpublishable draft', () => {
  it('a moved data root is detected, explained, and can be discarded', async () => {
    await ensureNoDraft();
    await startDraft('Moved', h.owner.id);
    await closeHost();
    // the data root was restored elsewhere: the marker names the old live folder
    const marker = join(h.dir, DRAFT_DIRNAME, '.smrt-draft.json');
    const parsed = JSON.parse(readFileSync(marker, 'utf8'));
    parsed.liveDir = join(h.dir, 'somewhere-else', 'user-app');
    writeFileSync(marker, JSON.stringify(parsed));
    const live = await getHost();
    expect(live.frozen).toBe(true); // still frozen: the draft is open
    const info = await draftInfo();
    expect(info?.publishable).toBe(false);
    expect(info?.problem).toMatch(/another app or location/);
    await expect(previewDraft()).rejects.toThrow(/another app or location/);
    expect(await discardNow()).toEqual({ discarded: 'Moved' });
    expect(live.frozen).toBe(false);
    expect(existsSync(join(h.dir, DRAFT_DIRNAME))).toBe(false);
  });

  it('a draft whose files are gone keeps live frozen and offers discard', async () => {
    await startDraft('Gone', h.owner.id);
    await closeHost();
    const { rmSync } = await import('node:fs');
    rmSync(join(h.dir, DRAFT_DIRNAME), { recursive: true, force: true });
    const live = await getHost();
    expect(live.frozen).toBe(true);
    const info = await draftInfo();
    expect(info).toMatchObject({ publishable: false, version: null });
    expect(info?.problem).toMatch(/missing/);
    await expect(hostFor('draft')).rejects.toThrow(/cannot be used/);
    await discardNow();
    expect(live.frozen).toBe(false);
  });

  it('a start that never finished is cleaned up at the next boot', async () => {
    await ensureNoDraft();
    const drafts = await AppDraftCollection.create({ db: h.db });
    const half = await drafts.create({
      name: 'Half',
      status: 'starting',
      createdBy: h.owner.id,
      createdAt: new Date().toISOString(),
    });
    await half.save();
    await closeHost();
    const live = await getHost();
    expect(live.frozen).toBe(false);
    expect(await getDraftSlot()).toBeNull();
    expect((await draftRow(half.id as string))?.status).toBe('discarded');
  });
});
