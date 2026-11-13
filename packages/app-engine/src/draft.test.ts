// Slice 2 of draft/publish: the copy op, forking a draft host, discarding it.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DRAFT_MARKER_FILE,
  removeDraftDirectory,
  writeDraftMarker,
} from './draft.ts';
import {
  AppHost,
  EngineError,
  MemoryVersionStore,
  type VersionRecord,
} from './index.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-draft-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (p: string) =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

describe('forkDraft', () => {
  const liveDir = join(root, 'user-app');
  const draftDir = join(root, 'user-app-draft');
  const liveStore = new MemoryVersionStore();
  const draftStore = new MemoryVersionStore();
  let live: AppHost;
  let draft: AppHost;

  beforeAll(async () => {
    live = await AppHost.open(liveDir, { store: liveStore });
    await live.execute(
      {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' }, notes: { type: 'text' } },
      },
      { author: 't' },
    );
    for (const t of ['one', 'two', 'three'])
      await live.create('Chore', { title: t, notes: `${t} notes` });
  });
  afterAll(async () => {
    await live.close();
  });

  it('copies the live data without touching live', async () => {
    const before = sha(join(liveDir, 'app.db'));
    draft = await live.forkDraft(draftDir, { store: draftStore });
    expect(sha(join(liveDir, 'app.db'))).toBe(before);
    expect(existsSync(join(draftDir, DRAFT_MARKER_FILE))).toBe(true);
    expect(draft.draft?.baseVersion).toBe(live.version);
    expect(draft.version).toBe(live.version);
    expect(draft.def).toEqual(live.def);
    expect((await draft.list('Chore')).map((r) => r.title).sort()).toEqual([
      'one',
      'three',
      'two',
    ]);
    // the base record is seeded into the draft's store, current points at it
    expect(await draftStore.current()).toBe(live.version);
    expect((await draftStore.get(live.version))?.summary).toBe(
      (await liveStore.get(live.version))?.summary,
    );
  });

  it('is isolated both ways: structure and records', async () => {
    // draft: risky change without approval (autoApprove), new record
    await draft.execute(
      { type: 'removeField', model: 'Chore', field: 'notes' },
      { author: 't' },
    );
    await draft.create('Chore', { title: 'draft-only' });
    expect(draft.def.models.Chore.fields.notes).toBeUndefined();
    expect(live.def.models.Chore.fields.notes).toBeTruthy();
    expect(live.version).toBe(draft.draft?.baseVersion);
    expect(await liveStore.maxVersion()).toBe(live.version);
    // live: record changes while the draft is open
    live.setFrozen(true);
    await live.create('Chore', { title: 'live-only', notes: 'n' });
    const liveTitles = (await live.list('Chore')).map((r) => r.title);
    const draftTitles = (await draft.list('Chore')).map((r) => r.title);
    expect(liveTitles).toContain('live-only');
    expect(liveTitles).not.toContain('draft-only');
    expect(draftTitles).toContain('draft-only');
    expect(draftTitles).not.toContain('live-only');
    // draft versions are numbered after the base and stored only in the draft's store
    expect(draft.version).toBe(live.version + 1);
    expect(await liveStore.get(draft.version)).toBeNull();
  });

  it('a draft cannot undo past its base', async () => {
    await draft.execute({ type: 'undo' }, { author: 't' });
    expect(draft.version).toBe(live.version);
    await expect(
      draft.execute({ type: 'undo' }, { author: 't' }),
    ).rejects.toThrow(/nothing to undo in the draft/);
    // and it can change again afterwards
    await draft.execute(
      {
        type: 'addField',
        model: 'Chore',
        field: 'size',
        definition: { type: 'integer' },
      },
      { author: 't' },
    );
    expect(draft.version).toBe(live.version + 2);
  });

  it('survives a restart with its own store', async () => {
    await draft.close();
    const again = await AppHost.open(draftDir, {
      store: draftStore,
      autoApprove: true,
    });
    try {
      expect(again.draft?.baseVersion).toBe(live.version);
      expect(again.def.models.Chore.fields.size).toBeTruthy();
      expect((await again.list('Chore')).length).toBeGreaterThan(0);
    } finally {
      await again.close();
    }
  });

  it('only an ordinary host can fork, once per directory, and not into or around live', async () => {
    const reopened = await AppHost.open(draftDir, {
      store: draftStore,
      autoApprove: true,
    });
    try {
      await expect(
        reopened.forkDraft(join(root, 'nested-draft'), {
          store: new MemoryVersionStore(),
        }),
      ).rejects.toMatchObject({ code: 'refused' });
    } finally {
      await reopened.close();
    }
    for (const bad of [
      liveDir,
      join(liveDir, 'inside'),
      join(liveDir, 'snapshots'),
      root, // contains live
      draftDir, // exists
    ])
      await expect(
        live.forkDraft(bad, { store: new MemoryVersionStore() }),
      ).rejects.toMatchObject({ code: 'refused' });
    // the live dir and the existing draft are intact
    expect(existsSync(join(liveDir, 'app.db'))).toBe(true);
    expect(existsSync(join(draftDir, 'app.db'))).toBe(true);
  });

  it('needs an empty store for the draft', async () => {
    const used = new MemoryVersionStore();
    await used.setCurrent(0);
    await expect(
      live.forkDraft(join(root, 'never'), { store: used }),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(existsSync(join(root, 'never'))).toBe(false);
  });

  it('removes the directory it created when the fork fails part-way', async () => {
    const failing = new MemoryVersionStore();
    failing.append = async (_r: VersionRecord) => {
      throw new Error('store is down');
    };
    const dir = join(root, 'half-made');
    await expect(live.forkDraft(dir, { store: failing })).rejects.toThrow(
      /store is down/,
    );
    expect(existsSync(dir)).toBe(false);
    // live still works
    await live.create('Chore', { title: 'after-failed-fork', notes: 'x' });
  });

  it('keeps a directory it did not create when the path was taken', async () => {
    const dir = join(root, 'taken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'precious.txt'), 'mine');
    await expect(
      live.forkDraft(dir, { store: new MemoryVersionStore() }),
    ).rejects.toMatchObject({ code: 'refused' });
    expect(readFileSync(join(dir, 'precious.txt'), 'utf8')).toBe('mine');
  });

  it('copes with writes in flight while forking', async () => {
    const dir = join(root, 'busy-draft');
    const writes = Array.from({ length: 12 }, (_, i) =>
      live.create('Chore', { title: `busy-${i}`, notes: 'n' }),
    );
    const busy = await live.forkDraft(dir, { store: new MemoryVersionStore() });
    await Promise.all(writes);
    try {
      const inDraft = (await busy.list('Chore', 1000)).map((r) => r.title);
      const inLive = (await live.list('Chore', 1000)).map((r) => r.title);
      expect(inLive.filter((t) => String(t).startsWith('busy-'))).toHaveLength(
        12,
      );
      for (const t of inDraft) expect(inLive).toContain(t);
    } finally {
      await busy.discard();
    }
  });

  it('discard removes the draft directory and nothing else', async () => {
    const sibling = join(root, 'sibling.txt');
    writeFileSync(sibling, 'keep');
    const liveHash = sha(join(liveDir, 'app.db'));
    const d = await AppHost.open(draftDir, {
      store: draftStore,
      autoApprove: true,
    });
    await d.discard();
    expect(existsSync(draftDir)).toBe(false);
    expect(readFileSync(sibling, 'utf8')).toBe('keep');
    expect(sha(join(liveDir, 'app.db'))).toBe(liveHash);
    // the host is closed
    await expect(d.list('Chore')).rejects.toThrow(/closed/);
  });

  it('a live host cannot be discarded', async () => {
    await expect(live.discard()).rejects.toMatchObject({ code: 'refused' });
    expect(existsSync(join(liveDir, 'app.db'))).toBe(true);
  });
});

describe('removeDraftDirectory', () => {
  it('refuses a directory without a marker, a forged self marker, and one containing live', () => {
    const plain = join(root, 'rm-plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'x'), '1');
    expect(() => removeDraftDirectory(plain)).toThrow(EngineError);
    expect(existsSync(join(plain, 'x'))).toBe(true);

    const self = join(root, 'rm-self');
    mkdirSync(self);
    writeDraftMarker(self, self, 0);
    expect(() => removeDraftDirectory(self)).toThrow(/contains the live/);
    expect(existsSync(self)).toBe(true);

    const outer = join(root, 'rm-outer');
    const inner = join(outer, 'live');
    mkdirSync(inner, { recursive: true });
    writeDraftMarker(outer, inner, 0);
    expect(() => removeDraftDirectory(outer)).toThrow(/contains the live/);
    expect(existsSync(inner)).toBe(true);
  });

  it('removes a real marked directory', () => {
    const live = join(root, 'rm-live');
    const d = join(root, 'rm-draft');
    mkdirSync(live);
    mkdirSync(d);
    writeDraftMarker(d, live, 0);
    removeDraftDirectory(d);
    expect(existsSync(d)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
