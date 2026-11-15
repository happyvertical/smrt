// Slice 3 of draft/publish: preview and publish (rehearsal on a fresh copy of
// live, guarded file swap, rollback, crash recovery). In-process, SQLite.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AppHost,
  ApprovalRequiredError,
  EngineError,
  MemoryVersionStore,
  type PublishStage,
  type VersionRecord,
  type VersionStore,
} from './index.ts';
import {
  ASIDE,
  chainDigest,
  JOURNAL_FILE,
  moveAside,
  restoreAside,
} from './publish.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-publish-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sha = (p: string) =>
  createHash('sha256').update(readFileSync(p)).digest('hex');
const names = (dir: string) => readdirSync(dir).sort();
const leftovers = (dir: string) =>
  names(dir).filter(
    (n) =>
      n === JOURNAL_FILE ||
      n.endsWith(ASIDE) ||
      n.startsWith('publish-rehearsal-'),
  );
const query = (dir: string, q: string): Record<string, unknown>[] => {
  const db = new DatabaseSync(join(dir, 'app.db'), { readOnly: true });
  try {
    return db.prepare(q).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};
const columns = (dir: string, table: string) =>
  query(dir, `select name from pragma_table_info('${table}')`).map((r) =>
    String(r.name),
  );
const AUTHOR = { author: 'tester' };
const OK = { author: 'tester', approved: true };

/** A store whose `commit` can be made to fail, and that can be cloned (a crash leaves the store as it was). */
class TestStore extends MemoryVersionStore {
  failCommit = false;
  override async commit(records: VersionRecord[], current: number) {
    if (this.failCommit) throw new Error('store write failed');
    return super.commit(records, current);
  }
}
async function cloneStore(s: MemoryVersionStore) {
  const c = new MemoryVersionStore();
  for (const r of await s.list()) await c.append(r);
  const cur = await s.current();
  if (cur !== null) await c.setCurrent(cur);
  return c;
}

let n = 0;
/** Live with a base of 3 versions and some rows, forked into a draft; live frozen. */
async function world(opts: { undoneBranch?: boolean } = {}) {
  const dir = join(root, `w${n++}`);
  const liveDir = join(dir, 'user-app');
  const draftDir = join(dir, 'user-app-draft');
  const liveStore = new TestStore();
  const draftStore = new MemoryVersionStore();
  const live = await AppHost.open(liveDir, { store: liveStore });
  await live.execute(
    {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text', required: true },
        notes: { type: 'text' },
        points: { type: 'text' },
      },
    },
    AUTHOR,
  );
  await live.execute(
    {
      type: 'addMethod',
      model: 'Chore',
      name: 'shout',
      method: { description: 'shout the title', code: 'return record.title;' },
    },
    OK,
  );
  await live.execute(
    {
      type: 'defineModel',
      name: 'Other',
      fields: { label: { type: 'text' } },
    },
    AUTHOR,
  );
  const ids: string[] = [];
  for (const [title, notes, points] of [
    ['Bins', 'blue bin', '3'],
    ['Dishes', 'after dinner', '5'],
    ['Garage', 'big job', 'lots'],
  ])
    ids.push(
      (await live.create('Chore', { title, notes, points })).id as string,
    );
  await live.create('Other', { label: 'o1' });
  await live.create('Other', { label: 'o2' });
  if (opts.undoneBranch) {
    await live.execute(
      {
        type: 'addField',
        model: 'Chore',
        field: 'scratch',
        definition: { type: 'text' },
      },
      AUTHOR,
    );
    await live.execute({ type: 'undo' }, AUTHOR);
  }
  const draft = await live.forkDraft(draftDir, { store: draftStore });
  live.setFrozen(true);
  return { dir, liveDir, draftDir, liveStore, draftStore, live, draft, ids };
}
type World = Awaited<ReturnType<typeof world>>;
const close = async (w: World) => {
  await w.draft.close().catch(() => {});
  await w.live.close();
};
const digestOf = async (w: World) =>
  chainDigest(w.live.version, await w.draft.draftChain());

describe('publish: what lands in live', () => {
  it('add-then-rename in one draft, a new model and a method', async () => {
    const w = await world();
    try {
      const d = w.draft;
      await d.execute(
        {
          type: 'addField',
          model: 'Chore',
          field: 'size',
          definition: { type: 'integer' },
        },
        AUTHOR,
      );
      await d.execute(
        { type: 'renameField', model: 'Chore', from: 'size', to: 'qty' },
        AUTHOR,
      );
      await d.execute(
        {
          type: 'defineModel',
          name: 'Tag',
          fields: { name: { type: 'text' } },
        },
        AUTHOR,
      );
      await d.execute(
        {
          type: 'addMethod',
          model: 'Tag',
          name: 'hello',
          method: { description: 'hi', code: 'return "hello";' },
        },
        AUTHOR,
      );
      const base = w.live.version;
      const preview = await w.live.previewPublish(d);
      const r = await w.live.publishDraft(d, {
        ...OK,
        expect: preview.digest,
        draftName: 'Spring  cleanup',
      });
      expect(r.version).toBe(base + 4);
      expect(r.versions).toEqual([base + 1, base + 2, base + 3, base + 4]);
      expect(w.live.version).toBe(base + 4);
      expect(w.live.def.models.Chore.fields.qty).toBeTruthy();
      expect(w.live.def.models.Chore.fields.size).toBeUndefined();
      expect(w.live.def.models.Tag).toBeTruthy();
      const cols = columns(w.liveDir, 'u_chores');
      expect(cols).toContain('qty');
      expect(cols).not.toContain('size');
      // live rows are intact and the app runs the new definition
      expect(await w.live.list('Chore')).toHaveLength(3);
      expect(await w.live.runMethod('Tag', 'hello')).toBeTruthy();
      // history: N ordinary versions, chained, tagged, current
      const vs = await w.live.versions();
      expect(vs.filter((v) => v.version > base).map((v) => v.summary)).toEqual([
        '[draft: Spring cleanup] add Chore.size',
        '[draft: Spring cleanup] rename Chore.size -> qty',
        '[draft: Spring cleanup] define Tag',
        '[draft: Spring cleanup] add method Tag.hello()',
      ]);
      expect(vs.find((v) => v.version === base + 1)?.parent).toBe(base);
      expect(await w.liveStore.current()).toBe(base + 4);
      expect(leftovers(w.liveDir)).toEqual([]);
      // the old data is retained as a snapshot
      const snaps = names(join(w.liveDir, 'snapshots')).filter((s) =>
        s.endsWith('-migrate-prepublish.db'),
      );
      expect(snaps).toHaveLength(1);
      expect(r.snapshot).toBe(join(w.liveDir, 'snapshots', snaps[0]));
      // and it still serves records, and thawing allows new structure
      w.live.setFrozen(false);
      await w.live.create('Chore', { title: 'new', qty: 2 });
      await w.live.execute(
        {
          type: 'addField',
          model: 'Tag',
          field: 'x',
          definition: { type: 'text' },
        },
        AUTHOR,
      );
    } finally {
      await close(w);
    }
  });

  it('remove, convert and archive, then undo restores the archived data', async () => {
    const w = await world();
    try {
      const d = w.draft;
      await d.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      await d.execute(
        {
          type: 'changeFieldType',
          model: 'Chore',
          field: 'points',
          to: { type: 'integer' },
        },
        AUTHOR,
      );
      await d.execute({ type: 'removeModel', model: 'Other' }, AUTHOR);
      // a live row written AFTER the fork, with data in both changed fields
      const late = (
        await w.live.create('Chore', {
          title: 'Late',
          notes: 'n!',
          points: '7',
        })
      ).id as string;
      const base = w.live.version;
      const preview = await w.live.previewPublish(d);
      // 4 notes values (3 + Late), 1 table; points archived too
      expect(preview.archives.tables).toBe(1);
      expect(preview.archives.values).toBeGreaterThanOrEqual(8);
      const r = await w.live.publishDraft(d, { ...OK, expect: preview.digest });
      expect(r.archives).toEqual(preview.archives);
      expect(w.live.version).toBe(base + 3);
      expect(columns(w.liveDir, 'u_chores')).not.toContain('notes');
      const rows = await w.live.list('Chore');
      expect(rows.find((x) => x.id === late)?.points).toBe(7);
      expect(rows.find((x) => x.title === 'Garage')?.points ?? null).toBeNull();
      expect(
        query(
          w.liveDir,
          `select count(*) as n from sqlite_master where name like '_archived_u_others_%'`,
        )[0].n,
      ).toBe(1);

      // the shell thaws live after a publish; then undo x3 (the type change
      // overwrites, so it needs approval)
      w.live.setFrozen(false);
      await w.live.execute({ type: 'undo' }, OK);
      await w.live.execute({ type: 'undo' }, OK);
      await w.live.execute({ type: 'undo' }, OK);
      expect(w.live.version).toBe(base);
      const back = await w.live.list('Chore');
      expect(back.find((x) => x.title === 'Garage')?.points).toBe('lots');
      expect(back.find((x) => x.title === 'Bins')?.notes).toBe('blue bin');
      expect(back.find((x) => x.id === late)?.notes).toBe('n!');
      expect(await w.live.list('Other')).toHaveLength(2);
    } finally {
      await close(w);
    }
  });

  it('keeps live records added after the fork, drops the draft ones, and holds records made during the publish', async () => {
    const w = await world();
    try {
      await w.draft.create('Chore', { title: 'draft-only' });
      await w.draft.execute(
        {
          type: 'addField',
          model: 'Chore',
          field: 'size',
          definition: { type: 'integer' },
        },
        AUTHOR,
      );
      await w.live.create('Chore', { title: 'live-after-fork', notes: 'x' });
      const { digest } = await w.live.previewPublish(w.draft);
      // a record written while the publish runs waits for it and lands in the new data
      const pub = w.live.publishDraft(w.draft, { ...OK, expect: digest });
      const during = w.live.create('Chore', { title: 'during-publish' });
      await Promise.all([pub, during]);
      const titles = (await w.live.list('Chore', 1000)).map((r) => r.title);
      expect(titles).toContain('live-after-fork');
      expect(titles).toContain('during-publish');
      expect(titles).not.toContain('draft-only');
      expect(titles).toHaveLength(5);
    } finally {
      await close(w);
    }
  });

  it('numbers the versions after everything live holds (live was on an undone branch)', async () => {
    const w = await world({ undoneBranch: true });
    try {
      expect(await w.liveStore.maxVersion()).toBe(w.live.version + 1);
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      const base = w.live.version;
      const { digest } = await w.live.previewPublish(w.draft);
      const r = await w.live.publishDraft(w.draft, { ...OK, expect: digest });
      expect(r.versions).toEqual([base + 2]);
      expect((await w.liveStore.get(base + 2))?.parent).toBe(base);
      w.live.setFrozen(false);
      // the archive is keyed by the number live gave it, so undo finds it
      await w.live.execute({ type: 'undo' }, AUTHOR);
      expect((await w.live.list('Chore'))[0].notes).toBeTruthy();
    } finally {
      await close(w);
    }
  });

  it('handles database side files (-wal, -shm, -journal) next to app.db', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      const { digest } = await w.live.previewPublish(w.draft);
      const before = sha(join(w.liveDir, 'app.db'));
      for (const f of ['app.db-wal', 'app.db-shm'])
        writeFileSync(join(w.liveDir, f), `stale ${f}`);
      // a failure after the swap: app.db is byte-for-byte as it was. (SQLite
      // itself deletes a -wal beside a rollback-mode database when it opens
      // it, so the side files are not asserted here; moveAside/restoreAside
      // are tested on their own below.)
      await expect(
        w.live.publishDraft(w.draft, {
          ...OK,
          expect: digest,
          onStage: (s) => {
            if (s === 'swapped') throw new Error('boom');
          },
        }),
      ).rejects.toThrow('boom');
      expect(sha(join(w.liveDir, 'app.db'))).toBe(before);
      expect(leftovers(w.liveDir)).toEqual([]);
      // a success leaves no stale side file next to the new database
      await w.live.publishDraft(w.draft, { ...OK, expect: digest });
      expect(columns(w.liveDir, 'u_chores')).not.toContain('notes');
      expect(leftovers(w.liveDir)).toEqual([]);
      for (const f of ['app.db-wal', 'app.db-shm'])
        if (existsSync(join(w.liveDir, f)))
          expect(readFileSync(join(w.liveDir, f), 'utf8')).not.toBe(
            `stale ${f}`,
          );
    } finally {
      await close(w);
    }
  });
});

describe('preview', () => {
  it('reports the diff, the archives and ALL method code, and changes nothing', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      await w.draft.execute(
        {
          type: 'addMethod',
          model: 'Chore',
          name: 'evil',
          method: { description: 'x', code: 'return "FULL-CODE-VISIBLE";' },
        },
        AUTHOR,
      );
      const before = sha(join(w.liveDir, 'app.db'));
      const files = names(w.liveDir);
      const base = w.live.version;
      const p = await w.live.previewPublish(w.draft);
      expect(p.risky).toBe(true);
      expect(p.fromVersion).toBe(base);
      expect(p.toVersion).toBe(base + 2);
      expect(p.versions.map((v) => v.summary)).toEqual([
        'remove Chore.notes',
        'add method Chore.evil()',
      ]);
      expect(p.versions[0].steps[0]).toMatchObject({ op: 'dropColumn' });
      expect(p.versions[0].statements.join('\n')).toMatch(/DROP COLUMN/);
      expect(p.definition.models.Chore.fieldsRemoved).toEqual(['notes']);
      expect(p.archives.values).toBe(3);
      const m = (name: string) => p.methods.find((x) => x.name === name);
      expect(m('evil')).toMatchObject({
        change: 'added',
        code: 'return "FULL-CODE-VISIBLE";',
      });
      expect(m('shout')).toMatchObject({
        change: 'unchanged',
        code: 'return record.title;',
      });
      // live is untouched
      expect(sha(join(w.liveDir, 'app.db'))).toBe(before);
      expect(names(w.liveDir)).toEqual(files);
      expect(w.live.version).toBe(base);
      expect(await w.liveStore.maxVersion()).toBe(base);
      // same chain, same digest
      expect((await w.live.previewPublish(w.draft)).digest).toBe(p.digest);
    } finally {
      await close(w);
    }
  });
});

describe('publish: refusals', () => {
  it('needs approval, a digest, the right digest, a draft with changes, and the same base', async () => {
    const w = await world();
    try {
      const { draft, live } = w;
      await expect(
        live.publishDraft(draft, { author: 'a', expect: 'x' }),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
      await expect(
        live.publishDraft(draft, { ...OK, expect: '' }),
      ).rejects.toMatchObject({ code: 'refused' });
      // nothing to publish
      await expect(live.previewPublish(draft)).rejects.toThrow(/no changes/);
      await draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      const { digest } = await live.previewPublish(draft);
      // the draft changes after the preview: refused, nothing published
      await draft.execute(
        { type: 'removeField', model: 'Chore', field: 'points' },
        AUTHOR,
      );
      const before = sha(join(w.liveDir, 'app.db'));
      await expect(
        live.publishDraft(draft, { ...OK, expect: digest }),
      ).rejects.toThrow(/not what was reviewed/);
      expect(sha(join(w.liveDir, 'app.db'))).toBe(before);
      expect(live.version).toBe(draft.draft?.baseVersion);
      // an undo inside the draft also changes the chain
      await draft.execute({ type: 'undo' }, AUTHOR);
      expect(await digestOf(w)).toBe(digest);
      await expect(
        live.publishDraft(draft, { ...OK, expect: digest }),
      ).resolves.toBeTruthy();
      // published: a second publish of the same draft is refused (live moved on)
      await expect(
        live.publishDraft(draft, { ...OK, expect: digest }),
      ).rejects.toThrow(/moved from version/);
    } finally {
      await close(w);
    }
  });

  it('refuses a live host, a foreign draft, a draft into a draft, and live that moved', async () => {
    const w = await world();
    const other = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      await other.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      await expect(w.live.previewPublish(w.live)).rejects.toThrow(
        /not a draft/,
      );
      await expect(w.live.previewPublish(other.draft)).rejects.toThrow(
        /another app or location/,
      );
      await expect(w.draft.previewPublish(w.draft)).rejects.toThrow(
        /into a draft/,
      );
      // live changes structure behind the draft's back (thawed)
      const { digest } = await w.live.previewPublish(w.draft);
      w.live.setFrozen(false);
      await w.live.execute(
        {
          type: 'addField',
          model: 'Chore',
          field: 'z',
          definition: { type: 'text' },
        },
        AUTHOR,
      );
      await expect(
        w.live.publishDraft(w.draft, { ...OK, expect: digest }),
      ).rejects.toThrow(/moved from version/);
    } finally {
      await close(w);
      await close(other);
    }
  });

  it('refuses when an aside file from earlier is there, and leaves it alone', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      const { digest } = await w.live.previewPublish(w.draft);
      writeFileSync(join(w.liveDir, `app.db${ASIDE}`), 'precious');
      const before = sha(join(w.liveDir, 'app.db'));
      await expect(
        w.live.publishDraft(w.draft, { ...OK, expect: digest }),
      ).rejects.toThrow(/already there/);
      expect(readFileSync(join(w.liveDir, `app.db${ASIDE}`), 'utf8')).toBe(
        'precious',
      );
      expect(sha(join(w.liveDir, 'app.db'))).toBe(before);
      expect(w.live.appAlive).toBe(true);
      expect(await w.live.list('Chore')).toHaveLength(3);
    } finally {
      await close(w);
    }
  });
});

describe('publish: a failure anywhere leaves live exactly as it was', () => {
  const STAGES: PublishStage[] = [
    'copied',
    'rehearsed',
    'snapshotted',
    'journaled',
    'retired',
    'moved-aside',
    'swapped',
    'respawned',
  ];
  async function intact(w: World, hash: string, base: number) {
    expect(sha(join(w.liveDir, 'app.db'))).toBe(hash);
    expect(w.live.version).toBe(base);
    expect(await w.liveStore.current()).toBe(base);
    expect(await w.liveStore.maxVersion()).toBe(base);
    expect(leftovers(w.liveDir)).toEqual([]);
    expect(w.live.appAlive).toBe(true);
    expect(w.live.def.models.Chore.fields.notes).toBeTruthy();
  }

  for (const failAt of STAGES)
    it(`failing after '${failAt}'`, async () => {
      const w = await world();
      try {
        await w.draft.execute(
          { type: 'removeField', model: 'Chore', field: 'notes' },
          AUTHOR,
        );
        const { digest } = await w.live.previewPublish(w.draft);
        const hash = sha(join(w.liveDir, 'app.db'));
        const base = w.live.version;
        await expect(
          w.live.publishDraft(w.draft, {
            ...OK,
            expect: digest,
            onStage: (s) => {
              if (s === failAt) throw new Error(`boom at ${s}`);
            },
          }),
        ).rejects.toThrow(`boom at ${failAt}`);
        await intact(w, hash, base);
        // live still works and the retry goes through
        expect(await w.live.list('Chore')).toHaveLength(3);
        await w.live.publishDraft(w.draft, { ...OK, expect: digest });
        expect(w.live.version).toBe(base + 1);
        expect(columns(w.liveDir, 'u_chores')).not.toContain('notes');
      } finally {
        await close(w);
      }
    });

  it('failing to write the store (atomic commit) rolls the swap back', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'points' },
        AUTHOR,
      );
      const { digest } = await w.live.previewPublish(w.draft);
      const hash = sha(join(w.liveDir, 'app.db'));
      const base = w.live.version;
      w.liveStore.failCommit = true;
      await expect(
        w.live.publishDraft(w.draft, { ...OK, expect: digest }),
      ).rejects.toThrow('store write failed');
      await intact(w, hash, base);
      expect(columns(w.liveDir, 'u_chores')).toContain('notes');
      w.liveStore.failCommit = false;
      await w.live.publishDraft(w.draft, { ...OK, expect: digest });
      expect(w.live.version).toBe(base + 2);
    } finally {
      await close(w);
    }
  });

  it('failing to write the store without atomic commit rolls back too (orphans stay unreachable)', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'points' },
        AUTHOR,
      );
      const { digest } = await w.live.previewPublish(w.draft);
      const hash = sha(join(w.liveDir, 'app.db'));
      const base = w.live.version;
      // a store with no commit(): the second append fails
      const inner = await cloneStore(w.liveStore);
      let calls = 0;
      let failing = true;
      const plain: VersionStore = {
        current: () => inner.current(),
        setCurrent: (v) => inner.setCurrent(v),
        get: (v) => inner.get(v),
        list: () => inner.list(),
        markPurged: (v) => inner.markPurged(v),
        maxVersion: () => inner.maxVersion(),
        append: async (r) => {
          if (failing && ++calls === 2) throw new Error('append failed');
          return inner.append(r);
        },
      };
      await w.live.close();
      const live2 = await AppHost.open(w.liveDir, { store: plain });
      live2.setFrozen(true);
      await expect(
        live2.publishDraft(w.draft, { ...OK, expect: digest }),
      ).rejects.toThrow('append failed');
      expect(sha(join(w.liveDir, 'app.db'))).toBe(hash);
      expect(live2.version).toBe(base);
      expect(await plain.current()).toBe(base);
      expect(leftovers(w.liveDir)).toEqual([]);
      // the retry numbers after the orphan and succeeds
      failing = false;
      const r = await live2.publishDraft(w.draft, { ...OK, expect: digest });
      expect(r.versions).toEqual([base + 2, base + 3]);
      await live2.close();
    } finally {
      await w.draft.close();
    }
  });

  it('a draft step that does not apply to the live data stops in the rehearsal', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      // tamper with the draft's stored step: a rename of a column that is not there
      const store = w.draftStore;
      const get = store.get.bind(store);
      store.get = async (v: number) => {
        const r = await get(v);
        if (r && v > (w.draft.draft?.baseVersion ?? 0) && r.migration)
          r.migration = {
            steps: [
              { op: 'renameColumn', table: 'u_chores', from: 'nope', to: 'x' },
            ],
          };
        return r;
      };
      const digest = await digestOf(w);
      const hash = sha(join(w.liveDir, 'app.db'));
      const base = w.live.version;
      await expect(w.live.previewPublish(w.draft)).rejects.toMatchObject({
        code: 'migration_failed',
      });
      await expect(
        w.live.publishDraft(w.draft, { ...OK, expect: digest }),
      ).rejects.toMatchObject({ code: 'migration_failed' });
      await intact(w, hash, base);
    } finally {
      await close(w);
    }
  });
});

describe('boot reconcile after a crash', () => {
  /** Copy the live directory and the store as a crash at `at` would leave them. */
  async function crashAt(at: PublishStage) {
    const w = await world();
    await w.draft.execute(
      { type: 'removeField', model: 'Chore', field: 'notes' },
      AUTHOR,
    );
    const { digest } = await w.live.previewPublish(w.draft);
    const hash = sha(join(w.liveDir, 'app.db'));
    const base = w.live.version;
    const crashed = join(w.dir, 'crashed');
    let crashedStore!: MemoryVersionStore;
    await w.live.publishDraft(w.draft, {
      ...OK,
      expect: digest,
      onStage: async (s) => {
        if (s !== at) return;
        cpSync(w.liveDir, crashed, { recursive: true });
        crashedStore = await cloneStore(w.liveStore);
      },
    });
    return { w, crashed, crashedStore, hash, base };
  }

  for (const at of ['journaled', 'retired', 'moved-aside', 'swapped'] as const)
    it(`a crash at '${at}' is rolled back at the next start`, async () => {
      const { w, crashed, crashedStore, hash, base } = await crashAt(at);
      try {
        const host = await AppHost.open(crashed, { store: crashedStore });
        try {
          expect(host.recovery).toBe('rolled-back');
          expect(host.version).toBe(base);
          expect(sha(join(crashed, 'app.db'))).toBe(hash);
          expect(leftovers(crashed)).toEqual([]);
          expect(await host.list('Chore')).toHaveLength(3);
          expect(columns(crashed, 'u_chores')).toContain('notes');
        } finally {
          await host.close();
        }
      } finally {
        await close(w);
      }
    });

  it('a crash after the store committed only cleans up', async () => {
    const { w, crashed, crashedStore, base } = await crashAt('committed');
    try {
      // the dir was copied before cleanup: journal and asides are there
      expect(names(crashed)).toContain(JOURNAL_FILE);
      expect(names(crashed)).toContain(`app.db${ASIDE}`);
      const host = await AppHost.open(crashed, { store: crashedStore });
      try {
        expect(host.recovery).toBe('rolled-forward');
        expect(host.version).toBe(base + 1);
        expect(leftovers(crashed)).toEqual([]);
        expect(columns(crashed, 'u_chores')).not.toContain('notes');
        expect(await host.list('Chore')).toHaveLength(3);
      } finally {
        await host.close();
      }
    } finally {
      await close(w);
    }
  });

  it('refuses to guess when the journal is unreadable', async () => {
    const dir = join(root, 'bad-journal');
    const store = new MemoryVersionStore();
    const h = await AppHost.open(dir, { store });
    await h.close();
    writeFileSync(join(dir, JOURNAL_FILE), '{broken');
    await expect(AppHost.open(dir, { store })).rejects.toThrow(/unreadable/);
    expect(existsSync(join(dir, 'app.db'))).toBe(true);
  });

  it('removes a stray rehearsal directory at start, and nothing else', async () => {
    const dir = join(root, 'stray');
    const store = new MemoryVersionStore();
    const h = await AppHost.open(dir, { store });
    await h.close();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'publish-rehearsal-abc123', 'final'), {
      recursive: true,
    });
    mkdirSync(join(dir, 'publish-rehearsal-not ours'), { recursive: true });
    const h2 = await AppHost.open(dir, { store });
    await h2.close();
    expect(existsSync(join(dir, 'publish-rehearsal-abc123'))).toBe(false);
    expect(existsSync(join(dir, 'publish-rehearsal-not ours'))).toBe(true);
  });
});

describe('moveAside / restoreAside', () => {
  const put = (dir: string, files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  };
  const read = (dir: string) =>
    Object.fromEntries(
      names(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
    );

  it('moves the main file last and restores any partial state', () => {
    const dir = mkdtempSync(join(root, 'aside-'));
    put(dir, {
      'app.db': 'old',
      'app.db-wal': 'oldwal',
      'app.db-shm': 'oldshm',
      'app.db-journal': 'oldj',
    });
    moveAside(dir);
    expect(names(dir)).toEqual(
      [
        `app.db-journal${ASIDE}`,
        `app.db-shm${ASIDE}`,
        `app.db-wal${ASIDE}`,
        `app.db${ASIDE}`,
      ].sort(),
    );
    // new database in place, with its own wal
    put(dir, { 'app.db': 'new', 'app.db-wal': 'newwal' });
    restoreAside(dir);
    expect(read(dir)).toEqual({
      'app.db': 'old',
      'app.db-wal': 'oldwal',
      'app.db-shm': 'oldshm',
      'app.db-journal': 'oldj',
    });
    restoreAside(dir); // again: no change
    expect(read(dir)['app.db']).toBe('old');
  });

  it('a state where only the side files moved leaves the main file alone', () => {
    const dir = mkdtempSync(join(root, 'aside-'));
    put(dir, {
      'app.db': 'old',
      [`app.db-wal${ASIDE}`]: 'oldwal',
      [`app.db-shm${ASIDE}`]: 'oldshm',
    });
    restoreAside(dir);
    expect(read(dir)).toEqual({
      'app.db': 'old',
      'app.db-wal': 'oldwal',
      'app.db-shm': 'oldshm',
    });
  });

  it('a state where the main file is aside and nothing is in place yet', () => {
    const dir = mkdtempSync(join(root, 'aside-'));
    put(dir, { [`app.db${ASIDE}`]: 'old' });
    restoreAside(dir);
    expect(read(dir)).toEqual({ 'app.db': 'old' });
  });

  it('moveAside refuses to overwrite an aside file and moves nothing', () => {
    const dir = mkdtempSync(join(root, 'aside-'));
    put(dir, { 'app.db': 'old', [`app.db-wal${ASIDE}`]: 'leftover' });
    expect(() => moveAside(dir)).toThrow(EngineError);
    expect(read(dir)).toEqual({
      'app.db': 'old',
      [`app.db-wal${ASIDE}`]: 'leftover',
    });
  });
});

describe('undoTo after a publish', () => {
  it('restores every archived value in one approved step', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        { type: 'removeField', model: 'Chore', field: 'notes' },
        AUTHOR,
      );
      await w.draft.execute(
        {
          type: 'changeFieldType',
          model: 'Chore',
          field: 'points',
          to: { type: 'integer' },
        },
        AUTHOR,
      );
      await w.draft.execute({ type: 'removeModel', model: 'Other' }, AUTHOR);
      const base = w.live.version;
      const { digest } = await w.live.previewPublish(w.draft);
      await w.live.publishDraft(w.draft, { ...OK, expect: digest });
      w.live.setFrozen(false);
      const cmd = { type: 'undoTo', version: base, from: base + 3 } as const;
      expect((await w.live.plan(cmd)).risky).toBe(true);
      await expect(w.live.execute(cmd, AUTHOR)).rejects.toBeInstanceOf(
        ApprovalRequiredError,
      );
      await w.live.execute(cmd, OK);
      expect(w.live.version).toBe(base);
      const rows = await w.live.list('Chore');
      expect(rows.find((x) => x.title === 'Garage')).toMatchObject({
        notes: 'big job',
        points: 'lots',
      });
      expect(await w.live.list('Other')).toHaveLength(2);
    } finally {
      await close(w);
    }
  });
});

describe('reviewed replay data impacts', () => {
  it('shows upsert counts from current live and refuses growth after review', async () => {
    const w = await world();
    try {
      await w.draft.execute(
        {
          type: 'loadRecords',
          model: 'Chore',
          mode: 'upsert',
          key: ['title'],
          rows: [{ title: 'New', notes: 'loaded' }],
        },
        AUTHOR,
      );
      const first = await w.live.previewPublish(w.draft);
      expect(first.versions.at(-1)?.dataSteps).toEqual([
        {
          op: 'loadRecords',
          model: 'Chore',
          mode: 'upsert',
          counts: expect.objectContaining({ insert: 1, update: 0 }),
        },
      ]);
      await w.live.create('Chore', { title: 'New', notes: 'live' });
      await expect(
        w.live.publishDraft(w.draft, { ...OK, expect: first.digest }),
      ).rejects.toThrow(/review.*again/);
      expect(
        (await w.live.list('Chore')).find((r) => r.title === 'New')?.notes,
      ).toBe('live');
      const fresh = await w.live.previewPublish(w.draft);
      expect(fresh.versions.at(-1)?.dataSteps?.[0].counts).toMatchObject({
        insert: 0,
        update: 1,
      });
      await w.live.publishDraft(w.draft, { ...OK, expect: fresh.digest });
      expect(
        (await w.live.list('Chore')).find((r) => r.title === 'New')?.notes,
      ).toBe('loaded');
    } finally {
      await close(w);
    }
  });
});

it('counts extract and merge steps sequentially against current live records', async () => {
  const w = await world();
  try {
    const others = await w.live.list('Other');
    await w.draft.execute(
      { type: 'extractModel', model: 'Chore', field: 'notes', into: 'Note' },
      AUTHOR,
    );
    await w.draft.execute(
      {
        type: 'mergeRecords',
        model: 'Other',
        keep: others[0].id as string,
        merge: [others[1].id as string],
      },
      AUTHOR,
    );
    await w.live.create('Chore', {
      title: 'Live extra',
      notes: 'new distinct',
    });
    const preview = await w.live.previewPublish(w.draft);
    const steps = preview.versions.flatMap((v) => v.dataSteps ?? []);
    expect(steps).toEqual([
      {
        op: 'extractModel',
        model: 'Chore',
        counts: { rows: 4, distinct: 4, folded: 0, create: 4, matched: 0 },
      },
      {
        op: 'mergeRecords',
        model: 'Other',
        counts: { removed: 1, references: {} },
      },
    ]);
    await w.live.create('Chore', { title: 'Later', notes: 'another distinct' });
    await expect(
      w.live.publishDraft(w.draft, { ...OK, expect: preview.digest }),
    ).rejects.toThrow(/review.*again/);
    expect(await w.live.list('Other')).toHaveLength(2);
    expect(w.live.def.models.Note).toBeUndefined();
  } finally {
    await close(w);
  }
});
