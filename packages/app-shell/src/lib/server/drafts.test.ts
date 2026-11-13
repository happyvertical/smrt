// Draft then publish, the shell's half: tables and stores, the lifecycle
// service, restart recovery with a draft open, and the publish / discard
// approvals. In-process SQLite, real workers, no network.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_APP, type VersionRecord } from '@happyvertical/smrt-app-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  requestDiscard,
  requestPublish,
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
  await runAs(h.owner, () =>
    App.defineModel('Chore', { title: { type: 'text' } }),
  );
  await (await getHost()).create('Chore', { title: 'live-1' });
});
afterAll(async () => {
  off();
  await h.close();
});

const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);
const titles = async (target: 'live' | 'draft') =>
  (await (await hostFor(target)).list('Chore'))
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

  it('refuses live structure naming the draft; live exports still work', async () => {
    await expect(
      asOwner(() => App.addField('Chore', 'points', { type: 'text' })),
    ).rejects.toThrow(/draft "Spring cleanup" is open/);
    await expect(
      runCommand({ type: 'undo' }, h.owner.id, 'live'),
    ).rejects.toThrow(/Spring cleanup/);
    expect(
      (await asOwner(() => App.exportTemplate())) as { format?: number },
    ).toMatchObject({ format: 1 });
    expect((await getHost()).frozen).toBe(true);
  });

  it('builds in the draft without approvals; the live definition is untouched', async () => {
    const live = await getHost();
    const liveVersion = live.version;
    const a = await runCommand(
      {
        type: 'addField',
        model: 'Chore',
        field: 'points',
        definition: { type: 'text' },
      },
      h.owner.id,
      'draft',
    );
    expect(isPending(a)).toBe(false);
    await runCommand(
      {
        type: 'defineModel',
        name: 'Extra',
        fields: { note: { type: 'text' } },
      },
      h.owner.id,
      'draft',
    );
    // a risky change in the draft is applied (autoApprove), never an Approval
    const removed = await runCommand(
      { type: 'removeField', model: 'Chore', field: 'points' },
      h.owner.id,
      'draft',
    );
    expect(isPending(removed)).toBe(false);
    await runCommand(
      {
        type: 'addField',
        model: 'Chore',
        field: 'points',
        definition: { type: 'text' },
      },
      h.owner.id,
      'draft',
    );
    expect(live.version).toBe(liveVersion);
    const liveDescribed = await describeCopy('live');
    expect(liveDescribed.mode).toBe('live');
    expect(liveDescribed.frozen).toBe(true);
    expect(liveDescribed.draft?.name).toBe('Spring cleanup');
    expect(Object.keys(liveDescribed.models)).not.toContain('Extra');
    const draftDescribed = await describeCopy('draft');
    expect(draftDescribed.mode).toBe('draft');
    expect(draftDescribed.frozen).toBe(false);
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
    await (await hostFor('live')).create('Chore', { title: 'live-2' });
    await (await hostFor('draft')).create('Chore', { title: 'draft-1' });
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
    const info = await draftInfo();
    expect(info).toMatchObject({
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
    await expect(
      asOwner(() => App.addField('Chore', 'x', { type: 'text' })),
    ).rejects.toThrow(/Spring cleanup/);
    // autoApprove is back on the reopened draft: a risky change just applies
    await runCommand(
      { type: 'defineModel', name: 'Scratch', fields: {} },
      h.owner.id,
      'draft',
    );
    const out = await runCommand(
      { type: 'removeModel', model: 'Scratch' },
      h.owner.id,
      'draft',
    );
    expect(isPending(out)).toBe(false);
  });
});

describe('publishing', () => {
  it('is ALWAYS an Approval pinned to the preview digest; nothing is applied until approved', async () => {
    const live = await getHost();
    const before = live.version;
    const { preview } = await previewDraft();
    const pending = await requestPublish(preview.digest, h.owner.id);
    expect(pending.status).toBe('pending_approval');
    expect(live.version).toBe(before);
    const row = (await (
      await ApprovalCollection.create({ db: h.db })
    ).get(pending.approvalId)) as Approval;
    expect(JSON.parse(row.command)).toMatchObject({
      kind: 'publish-draft',
      digest: preview.digest,
      draftName: 'Spring cleanup',
    });
    const shown = pending.preview as {
      digest: string;
      methods: unknown[];
      definition: unknown;
    };
    expect(shown.digest).toBe(preview.digest);
    expect(Array.isArray(shown.methods)).toBe(true);
    // asking again with the same chain reuses the pending row
    expect((await requestPublish(undefined, h.owner.id)).approvalId).toBe(
      pending.approvalId,
    );
    await expect(requestPublish('not-the-digest', h.owner.id)).rejects.toThrow(
      /changed since it was reviewed/,
    );
    await decide(pending.approvalId, false);
    expect(live.version).toBe(before);
    expect(await getDraftSlot()).not.toBeNull();
  });

  it('refuses to apply when the draft changed after the approval was requested', async () => {
    const live = await getHost();
    const before = live.version;
    const pending = await requestPublish(undefined, h.owner.id);
    await runCommand(
      { type: 'defineModel', name: 'Late', fields: {} },
      h.owner.id,
      'draft',
    );
    const out = await decide(pending.approvalId, true);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/not what was reviewed|changed since/);
    expect(live.version).toBe(before);
    expect(await getDraftSlot()).not.toBeNull();
    expect(live.frozen).toBe(true);
    await runCommand(
      { type: 'removeModel', model: 'Late' },
      h.owner.id,
      'draft',
    );
  });

  it('a failed commit leaves live exactly as it was (the store is transactional)', async () => {
    const live = await getHost();
    const store = new ShellVersionStore(h.db);
    const versionsBefore = (await store.list()).length;
    const liveJson = JSON.stringify(live.describe());
    const pending = await requestPublish(undefined, h.owner.id);
    // make the commit's transaction fail: the draft row is not `open`
    const slot = (await getDraftSlot()) as NonNullable<
      Awaited<ReturnType<typeof getDraftSlot>>
    >;
    const row = (await draftRow(slot.id)) as NonNullable<
      Awaited<ReturnType<typeof draftRow>>
    >;
    row.status = 'discarded';
    await row.save();
    const out = await decide(pending.approvalId, true);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/no longer open/);
    expect((await store.list()).length).toBe(versionsBefore); // no orphan versions
    expect(live.version).toBe((await store.current()) as number);
    expect(JSON.stringify(live.describe())).toBe(liveJson);
    expect(await titles('live')).toEqual(['live-1', 'live-2']);
    expect(live.appAlive).toBe(true);
    const fresh = (await draftRow(slot.id)) as NonNullable<
      Awaited<ReturnType<typeof draftRow>>
    >;
    fresh.status = 'open';
    await fresh.save();
    expect(await getDraftSlot()).not.toBeNull();
  });

  it('publishes on approval: live gets the versions, records survive, the draft is gone', async () => {
    const live = await getHost();
    const before = live.version;
    await live.create('Chore', { title: 'live-3' }); // added while the draft is open
    const pending = await requestPublish(undefined, h.owner.id);
    const slot = (await getDraftSlot()) as NonNullable<
      Awaited<ReturnType<typeof getDraftSlot>>
    >;
    const out = await decide(pending.approvalId, true);
    expect(out.status).toBe('approved');
    const result = out.result as {
      version: number;
      versions: number[];
      draft: string;
      snapshot?: string;
    };
    expect(result.draft).toBe('Spring cleanup');
    expect(result.snapshot).toBeUndefined();
    expect(result.versions.length).toBeGreaterThan(0);
    expect(live.version).toBe(result.version);
    expect(live.version).toBeGreaterThan(before);
    expect(live.frozen).toBe(false);
    expect(await getDraftSlot()).toBeNull();
    expect(existsSync(join(h.dir, DRAFT_DIRNAME))).toBe(false);
    expect(Object.keys(live.describe().models)).toContain('Extra');
    // live records stay, including the one made during the draft; draft ones are not carried
    expect(await titles('live')).toEqual(['live-1', 'live-2', 'live-3']);
    const stored = await draftRow(slot.id);
    expect(stored?.status).toBe('published');
    expect(JSON.parse(stored?.publishedVersions ?? '[]')).toEqual(
      result.versions,
    );
    expect(
      events.some((e) => e.type === 'draft' && e.status === 'published'),
    ).toBe(true);
    // History groups the publish; the live store has every version
    const history = await historyFor('live');
    const grouped = history.filter((v) => v.publish?.draftId === slot.id);
    expect(grouped.map((v) => v.version)).toEqual(result.versions);
    expect(
      grouped.every((v) => v.summary.startsWith('[draft: Spring cleanup] ')),
    ).toBe(true);
    // live structure works again
    const again = await asOwner(() =>
      App.addField('Chore', 'done', { type: 'boolean' }),
    );
    expect(isPending(again)).toBe(false);
    // the draft's version rows are kept (never deleted), grouped by draft id
    const kept = await (
      await AppDraftVersionCollection.create({ db: h.db })
    ).list({
      where: { draftId: slot.id },
      limit: 100,
    });
    expect(kept.length).toBeGreaterThan(1);
  });

  it('undoTo goes back over a whole publish in one step', async () => {
    const live = await getHost();
    const history = await historyFor('live');
    const group = history.filter((v) => v.publish);
    const first = group[0];
    const target = first.parent as number;
    // the "done" field added after the publish comes off too
    const out = await asOwner(() => App.undoTo(target));
    expect(isPending(out)).toBe(false);
    expect(live.version).toBe(target);
    expect(Object.keys(live.describe().models)).not.toContain('Extra');
    expect(await titles('live')).toEqual(['live-1', 'live-2', 'live-3']);
  });
});

describe('discarding', () => {
  it('a tool-asked discard is an Approval; the direct discard is the owner action', async () => {
    await ensureNoDraft();
    const live = await getHost();
    await startDraft('Throwaway', h.owner.id);
    expect(live.frozen).toBe(true);
    const pending = await asOwner(() => App.discardDraft());
    expect((pending as { status: string }).status).toBe('pending_approval');
    expect(await getDraftSlot()).not.toBeNull(); // nothing happened yet
    const slot = (await getDraftSlot()) as NonNullable<
      Awaited<ReturnType<typeof getDraftSlot>>
    >;
    const dir = join(h.dir, DRAFT_DIRNAME);
    expect(existsSync(dir)).toBe(true);
    const out = await decide(
      (pending as { approvalId: string }).approvalId,
      true,
    );
    expect(out.status).toBe('approved');
    expect(await getDraftSlot()).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect(live.frozen).toBe(false);
    expect((await draftRow(slot.id))?.status).toBe('discarded');
    await expect(discardNow()).rejects.toThrow(/no draft/);

    await startDraft('Direct', h.owner.id);
    const stale = await requestDiscard(h.owner.id);
    await expect(discardNow('some-other-draft')).rejects.toThrow(
      /not the draft/,
    );
    expect(await discardNow()).toEqual({ discarded: 'Direct' });
    expect(live.frozen).toBe(false);
    // an approval for a draft that is gone does not discard the next one
    await startDraft('Next', h.owner.id);
    const late = await decide(stale.approvalId, true);
    expect(late.status).toBe('failed');
    expect(await getDraftSlot()).not.toBeNull();
    await discardNow();
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
    await expect(requestPublish(undefined, h.owner.id)).rejects.toThrow(
      /another app or location/,
    );
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
