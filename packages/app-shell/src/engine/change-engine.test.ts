// ChangeEngine (#5202): rebuild, checkBatch, undoBatch over the SQLite adapter.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type BatchCommand,
  batchDigest,
  createSqliteChangeEngine,
  findChainBlockers,
} from './change-engine.ts';
import {
  AppHost,
  type Command,
  EMPTY_APP,
  MemoryVersionStore,
} from './index.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-change-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const engine = createSqliteChangeEngine();
const me = { id: 'owner' };
const AUTHOR = { author: 'tester', approved: true };
const sha = (p: string) =>
  createHash('sha256').update(readFileSync(p)).digest('hex');

let n = 0;
async function world() {
  const dir = join(root, `w${n++}`);
  const liveDir = join(dir, 'user-app');
  const live = await AppHost.open(liveDir, { store: new MemoryVersionStore() });
  await live.execute(
    {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text' },
        notes: { type: 'text' },
        points: { type: 'integer' },
      },
    },
    AUTHOR,
  );
  await live.create('Chore', { title: 'Bins', notes: 'blue', points: 3 });
  let k = 0;
  const rebuild = (commands: BatchCommand[], signal?: AbortSignal) =>
    engine.rebuild(me, live, {
      draftDir: join(dir, `draft${k++}`),
      store: new MemoryVersionStore(),
      commands,
      author: 'tester',
      signal,
    });
  return { dir, liveDir, live, rebuild };
}

const addSize: Command = {
  type: 'addField',
  model: 'Chore',
  field: 'size',
  definition: { type: 'integer' },
};
const renameSize: Command = {
  type: 'renameField',
  model: 'Chore',
  from: 'size',
  to: 'qty',
};
const defineTag: Command = {
  type: 'defineModel',
  name: 'Tag',
  fields: { name: { type: 'text' } },
};

describe('rebuild', () => {
  it('removing a card from the middle keeps the rest', async () => {
    const w = await world();
    const r = await w.rebuild([
      { key: 'a', command: addSize },
      { key: 'b', command: { ...defineTag } },
      { key: 'c', command: renameSize },
    ]);
    expect(r.blockers).toEqual([]);
    // card b removed: rebuild from the remaining commands
    await r.draft.discard();
    const r2 = await w.rebuild([
      { key: 'a', command: addSize },
      { key: 'c', command: renameSize },
    ]);
    expect(r2.blockers).toEqual([]);
    expect(r2.applied.map((a) => a.key)).toEqual(['a', 'c']);
    expect(r2.draft.def.models.Tag).toBeUndefined();
    expect(r2.draft.def.models.Chore.fields.qty).toBeTruthy();
    await r2.draft.close();
    await w.live.close();
  });

  it('removing the card others depend on blocks only the dependents', async () => {
    const w = await world();
    const r = await w.rebuild([
      { key: 'b', command: defineTag },
      { key: 'c', command: renameSize }, // its addField (a) was removed
    ]);
    expect(r.blockers.map((b) => [b.key, b.code])).toEqual([
      ['c', 'depends_on_removed'],
    ]);
    expect(r.applied.map((a) => a.key)).toEqual(['b']);
    expect(r.draft.def.models.Tag).toBeTruthy();
    await r.draft.close();
    await w.live.close();
  });

  it('a report that uses a field blocks the card that removes it', async () => {
    const w = await world();
    const report: Command = {
      type: 'defineReport',
      name: 'totals',
      definition: {
        spec: parseRuntimeReportSpec({
          version: 1,
          title: 'Totals',
          source: 'Chore',
          dimensions: [{ field: 'title' }],
          measures: [{ fn: 'sum', field: 'points', as: 'total' }],
        }),
      },
    };
    const r = await w.rebuild([
      { key: 'r', command: report },
      {
        key: 'x',
        command: { type: 'removeField', model: 'Chore', field: 'points' },
      },
      { key: 'y', command: defineTag },
    ]);
    expect(r.blockers.map((b) => [b.key, b.code])).toEqual([
      ['x', 'depends_on_removed'],
    ]);
    expect(r.blockers[0].message).toMatch(/report totals/);
    expect(r.applied.map((a) => a.key)).toEqual(['r', 'y']);
    await r.draft.close();
    await w.live.close();
  });

  it('an interrupted rebuild leaves live untouched', async () => {
    const w = await world();
    const before = sha(join(w.liveDir, 'app.db'));
    const version = w.live.version;
    const ctl = new AbortController();
    const draftDir = join(w.dir, 'interrupted');
    const hook = new Proxy(new MemoryVersionStore(), {});
    await expect(
      engine.rebuild(me, w.live, {
        draftDir,
        store: hook,
        author: 'tester',
        signal: ctl.signal,
        commands: [
          { key: 'a', command: addSize },
          {
            key: 'boom',
            get command(): Command {
              ctl.abort(); // the process is told to stop after the first card
              return defineTag;
            },
          },
          { key: 'c', command: renameSize },
        ],
      }),
    ).rejects.toThrow(/interrupted/);
    expect(existsSync(draftDir)).toBe(false);
    expect(w.live.version).toBe(version);
    expect(sha(join(w.liveDir, 'app.db'))).toBe(before);
    expect(w.live.def.models.Chore.fields.size).toBeUndefined();
    await w.live.close();
  });
});

describe('checkBatch', () => {
  it('add-then-rename is clean and shows overwrite counts without blocking', async () => {
    const w = await world();
    const r = await w.rebuild([
      { key: 'a', command: addSize },
      { key: 'b', command: renameSize },
    ]);
    const check = await engine.checkBatch(me, w.live, r.draft);
    expect(check.blockers).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.engineDigest).toBe(check.preview?.digest);
    expect(check.overwrites.recordsUpdated).toBe(0);
    expect(
      batchDigest(check.engineDigest as string, [{ id: 'a', revision: 1 }]),
    ).not.toBe(
      batchDigest(check.engineDigest as string, [{ id: 'a', revision: 2 }]),
    );
    await r.draft.close();
    await w.live.close();
  });

  it('flags one field changed by two cards', async () => {
    const w = await world();
    const r = await w.rebuild([
      {
        key: 'a',
        command: {
          type: 'renameField',
          model: 'Chore',
          from: 'notes',
          to: 'x',
        },
      },
      {
        key: 'b',
        command: { type: 'renameField', model: 'Chore', from: 'x', to: 'y' },
      },
    ]);
    const check = await engine.checkBatch(me, w.live, r.draft);
    expect(check.ok).toBe(false);
    expect(check.blockers.map((b) => b.code)).toEqual(['same_field_twice']);
    await r.draft.close();
    await w.live.close();
  });

  it('flags a moved base and an empty batch is fine', async () => {
    const w = await world();
    const r = await w.rebuild([]);
    expect((await engine.checkBatch(me, w.live, r.draft)).ok).toBe(true);
    await w.live.execute(defineTag, AUTHOR); // live structure moves on
    const moved = await engine.checkBatch(me, w.live, r.draft);
    expect(moved.blockers.map((b) => b.code)).toEqual(['base_moved']);
    await r.draft.close();
    await w.live.close();
  });

  it('flags a report that uses a removed field', () => {
    const spec = parseRuntimeReportSpec({
      version: 1,
      title: 'T',
      source: 'Chore',
      dimensions: [{ field: 'gone' }],
      measures: [{ fn: 'count', as: 'n' }],
    });
    const def = {
      ...EMPTY_APP,
      models: { Chore: { fields: { title: { type: 'text' as const } } } },
      reports: { t: { spec } },
    };
    const rec = {
      version: 2,
      parent: 1,
      author: 't',
      summary: 'remove points',
      definition: def,
      migration: null,
      createdAt: '',
    };
    const blockers = findChainBlockers({
      baseVersion: 1,
      base: { ...rec, version: 1, parent: null },
      versions: [rec],
    } as never);
    expect(blockers.map((b) => b.code)).toEqual(['report_uses_removed_field']);
  });
});

describe('undoBatch', () => {
  it('keeps records added after Apply and brings archived values back', async () => {
    const w = await world();
    const r = await w.rebuild([
      { key: 'a', command: addSize },
      {
        key: 'b',
        command: { type: 'removeField', model: 'Chore', field: 'notes' },
      },
    ]);
    const check = await engine.checkBatch(me, w.live, r.draft);
    expect(check.ok).toBe(true);
    const applied = await engine.publishDraft(me, w.live, r.draft, {
      author: 'tester',
      approved: true,
      expect: check.engineDigest as string,
    });
    await r.draft.discard();
    await w.live.create('Chore', { title: 'Added after', points: 9 });
    expect(w.live.def.models.Chore.fields.notes).toBeUndefined();

    await engine.undoBatch(me, w.live, {
      versions: applied.versions,
      author: 'tester',
    });
    expect(w.live.def.models.Chore.fields.notes).toBeTruthy();
    expect(w.live.def.models.Chore.fields.size).toBeUndefined();
    const rows = await w.live.list('Chore');
    expect(rows.map((x) => x.title).sort()).toEqual(['Added after', 'Bins']);
    expect(rows.find((x) => x.title === 'Bins')?.notes).toBe('blue');
    await w.live.close();
  });

  it('refuses versions that are not the newest applied batch', async () => {
    const w = await world();
    await expect(
      engine.undoBatch(me, w.live, { versions: [99], author: 't' }),
    ).rejects.toThrow(/missing/);
    await w.live.close();
  });
});
