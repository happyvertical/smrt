// Review findings: undo that overwrites newer data is gated; the app's REST
// surface is only its own collections; snapshots are pruned; an imported
// template's code is shown in full.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppHost,
  ApprovalRequiredError,
  MemoryVersionStore,
  type Template,
} from './index.ts';
import {
  METHOD_SNAPSHOTS_KEPT,
  pruneMethodSnapshots,
  pruneMigrationSnapshots,
} from './snapshots.ts';

const dirs: string[] = [];
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `engine-${name}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const asked = { author: 't' };
const ok = { author: 't', approved: true };

describe('undo that overwrites newer data', () => {
  let host: AppHost;
  const ids: string[] = [];
  beforeAll(async () => {
    host = await AppHost.open(tmp('undo'), { store: new MemoryVersionStore() });
    await host.execute(
      {
        type: 'defineModel',
        name: 'Task',
        fields: { points: { type: 'text' } },
      },
      asked,
    );
    for (const p of ['1', '2', '3'])
      ids.push((await host.create('Task', { points: p })).id as string);
    await host.execute(
      {
        type: 'changeFieldType',
        model: 'Task',
        field: 'points',
        to: { type: 'integer' },
      },
      ok,
    );
  });

  it('plans a risky undo with the count of rows it would overwrite', async () => {
    await host.update('Task', ids[0], { points: 90 }); // edited since
    await host.update('Task', ids[1], { points: 2 }); // same value as converted original
    await host.create('Task', { points: 7 }); // made since: not archived
    const plan = await host.plan({ type: 'undo' });
    expect(plan.risky).toBe(true);
    expect(plan.preview).toMatchObject({
      replaced: 1,
      fields: [{ model: 'Task', field: 'points', rows: 1 }],
    });
  });

  it('refuses without approval and changes nothing; approving applies it', async () => {
    const version = host.version;
    await expect(host.execute({ type: 'undo' }, asked)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    await expect(
      host.execute({ type: 'undo' }, { author: 't', approved: false }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(host.version).toBe(version);
    expect((await host.get('Task', ids[0])).points).toBe(90);

    // approved for a version the app has moved on from: refused
    await expect(
      host.execute({ type: 'undo', version: version + 5 }, ok),
    ).rejects.toThrow(/changed since/);
    expect(host.version).toBe(version);

    await host.execute({ type: 'undo', version }, ok);
    expect(host.version).toBe(version - 1);
    expect((await host.get('Task', ids[0])).points).toBe('1'); // original won
  });

  it('undo of a change without a conversion stays immediate', async () => {
    await host.execute(
      {
        type: 'addField',
        model: 'Task',
        field: 'note',
        definition: { type: 'text' },
      },
      asked,
    );
    expect((await host.plan({ type: 'undo' })).risky).toBe(false);
    await host.execute({ type: 'undo' }, asked);
  });
});

describe('the app REST surface', () => {
  let host: AppHost;
  let id = '';
  const chores = '/api/chores';
  beforeAll(async () => {
    host = await AppHost.open(tmp('rest'), { store: new MemoryVersionStore() });
    await host.execute(
      {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      },
      asked,
    );
    id = (await host.create('Chore', { title: 'keep me' })).id as string;
  });

  it('refuses sync/apply (its delete op bypasses the DELETE gate) and deletes nothing', async () => {
    const body = JSON.stringify({
      items: [{ itemId: 'i1', object: 'chores', op: 'delete', id }],
    });
    for (const approved of [false, true]) {
      const r = await host.rest(
        { method: 'POST', url: '/api/sync/apply', body },
        { approved },
      );
      expect(r.status).toBe(404);
    }
    expect((await host.get('Chore', id)).title).toBe('keep me');
  });

  it('refuses reserved endpoints, unknown collections and odd paths', async () => {
    for (const url of [
      '/api/_changes',
      '/api/_events',
      '/api/_inference',
      '/api/profile_types',
      '/api/profiletypes',
      '/api/chores/_x',
      '/api/chores/a/b',
      '/api//sync//apply',
      '/api/%73ync/apply',
      '/other/chores',
      '/api',
    ]) {
      const r = await host.rest({ method: 'GET', url });
      expect(r.status, url).toBe(404);
    }
    expect(
      (
        await host.rest(
          { method: 'DELETE', url: '/api/profile_types/x' },
          { approved: true },
        )
      ).status,
    ).toBe(404);
    // a DELETE of a reserved path asks for no approval either
    await expect(
      host.rest({ method: 'DELETE', url: '/api/sync/apply' }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it('keeps normal CRUD and the DELETE gate', async () => {
    expect((await host.rest({ method: 'GET', url: chores })).status).toBe(200);
    expect(
      (await host.rest({ method: 'GET', url: `${chores}/${id}` })).status,
    ).toBe(200);
    const made = await host.rest({
      method: 'POST',
      url: chores,
      body: JSON.stringify({ title: 'via rest' }),
    });
    expect(made.status).toBeLessThan(300);
    await expect(
      host.rest({ method: 'DELETE', url: `${chores}/${id}` }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect((await host.get('Chore', id)).title).toBe('keep me');
  });
});

describe('snapshot retention', () => {
  const name = (at: number, n: number, kind: string) => `${at}-${n}-${kind}.db`;

  it('keeps only the newest method snapshots, and touches nothing else', () => {
    const dir = tmp('prune');
    const outside = join(tmp('outside'), 'target.db');
    writeFileSync(outside, 'x');
    for (let i = 0; i < 25; i++)
      writeFileSync(join(dir, name(1000 + i, 0, 'method-Chore.done')), 'x');
    writeFileSync(join(dir, name(1, 0, 'migrate-v1-up')), 'x');
    writeFileSync(join(dir, name(2, 0, 'schema')), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'app-backup.db'), 'x');
    mkdirSync(join(dir, name(3, 0, 'method-dir')));
    symlinkSync(outside, join(dir, name(4, 0, 'method-link')));

    expect(pruneMethodSnapshots(dir)).toBe(25 - METHOD_SNAPSHOTS_KEPT);
    const left = readdirSync(dir);
    const methods = left.filter((f) => /^\d+-0-method-Chore/.test(f));
    expect(methods).toHaveLength(METHOD_SNAPSHOTS_KEPT);
    expect(methods).toContain(name(1024, 0, 'method-Chore.done')); // newest stays
    expect(left).not.toContain(name(1000, 0, 'method-Chore.done')); // oldest goes
    for (const kept of [
      name(1, 0, 'migrate-v1-up'),
      name(2, 0, 'schema'),
      'notes.txt',
      'app-backup.db',
      name(3, 0, 'method-dir'),
      name(4, 0, 'method-link'),
    ])
      expect(left).toContain(kept);
    expect(existsSync(outside)).toBe(true);
  });

  it('prunes migrate and schema snapshots only before the cutoff', () => {
    const dir = tmp('prune2');
    for (const [at, kind] of [
      [10, 'migrate-v1-up'],
      [20, 'schema'],
      [30, 'migrate-v2-down'],
      [40, 'method-Chore.x'],
    ] as const)
      writeFileSync(join(dir, name(at, 0, kind)), 'x');
    expect(pruneMigrationSnapshots(dir, 25)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(
      [name(30, 0, 'migrate-v2-down'), name(40, 0, 'method-Chore.x')].sort(),
    );
  });

  it('the worker prunes after each applied method write; cleanUp prunes old migrations', async () => {
    const dir = tmp('prune3');
    const host = await AppHost.open(dir, { store: new MemoryVersionStore() });
    try {
      await host.execute(
        {
          type: 'defineModel',
          name: 'Chore',
          fields: { n: { type: 'integer' } },
        },
        asked,
      );
      await host.execute(
        {
          type: 'addMethod',
          model: 'Chore',
          name: 'add',
          method: {
            description: 'adds a chore',
            code: `app.create('Chore', { n: 1 }); return 1;`,
          },
        },
        ok,
      );
      const snaps = join(dir, 'snapshots');
      for (let i = 0; i < METHOD_SNAPSHOTS_KEPT + 4; i++)
        await host.runMethod('Chore', 'add');
      const methodFiles = () =>
        readdirSync(snaps).filter((f) => /-method-/.test(f));
      expect(methodFiles()).toHaveLength(METHOD_SNAPSHOTS_KEPT);

      // fake old and fresh migration snapshots (plain files)
      const old = join(snaps, name(5, 0, 'migrate-v1-up'));
      const fresh = join(snaps, name(9_999_999_999_999, 0, 'migrate-v9-up'));
      writeFileSync(old, 'x');
      writeFileSync(fresh, 'x');
      utimesSync(old, 1, 1);
      const out = (await host.execute({ type: 'cleanUp', keep: 0 }, ok)) as {
        snapshots: number;
      };
      expect(out.snapshots).toBeGreaterThanOrEqual(1);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(methodFiles()).toHaveLength(METHOD_SNAPSHOTS_KEPT);
    } finally {
      await host.close();
    }
  });
});

describe('importTemplate approval shows the code', () => {
  it('lists each method with its code, params and description', async () => {
    const src = await AppHost.open(tmp('tpl-src'), {
      store: new MemoryVersionStore(),
    });
    const dst = await AppHost.open(tmp('tpl-dst'), {
      store: new MemoryVersionStore(),
    });
    try {
      await src.execute(
        {
          type: 'defineModel',
          name: 'Chore',
          fields: { n: { type: 'integer' } },
        },
        asked,
      );
      await src.execute(
        {
          type: 'addMethod',
          model: 'Chore',
          name: 'bump',
          method: {
            description: 'bumps n',
            code: `return params.by + 1;`,
            params: { by: { type: 'integer', required: true } },
          },
        },
        ok,
      );
      const tpl = (await src.execute(
        { type: 'exportTemplate' },
        asked,
      )) as Template;
      const plan = await dst.plan({ type: 'importTemplate', data: tpl });
      expect(plan.risky).toBe(true);
      expect(plan.preview).toMatchObject({
        models: ['Chore'],
        methods: [
          {
            model: 'Chore',
            name: 'bump',
            description: 'bumps n',
            code: 'return params.by + 1;',
            params: { by: { type: 'integer', required: true } },
          },
        ],
        records: 0,
      });

      const huge = structuredClone(tpl);
      huge.definition.models.Chore.methods = Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [
          `m${i}`,
          { description: 'd', code: `return ${i};${' '.repeat(19_000)}` },
        ]),
      );
      await expect(
        dst.plan({ type: 'importTemplate', data: huge }),
      ).rejects.toThrow(/too much code to review/);
    } finally {
      await src.close();
      await dst.close();
    }
  });
});
