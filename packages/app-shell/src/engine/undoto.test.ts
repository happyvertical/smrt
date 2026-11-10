// Slice 4 of draft/publish: undoTo(version) = undo repeated, one decision.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppHost, ApprovalRequiredError, MemoryVersionStore } from './index.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-undoto-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const AUTHOR = { author: 't' };
const OK = { author: 't', approved: true };
let n = 0;

/**
 * v1 define Chore, v2 add size, v3 remove notes (archive), v4 points text ->
 * integer (convert), v5 add method.
 */
async function build(store = new MemoryVersionStore()) {
  const host = await AppHost.open(join(root, `h${n++}`), { store });
  await host.execute(
    {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text' },
        notes: { type: 'text' },
        points: { type: 'text' },
      },
    },
    AUTHOR,
  );
  for (const [title, notes, points] of [
    ['a', 'note a', '3'],
    ['b', 'note b', 'lots'],
  ])
    await host.create('Chore', { title, notes, points });
  await host.execute(
    {
      type: 'addField',
      model: 'Chore',
      field: 'size',
      definition: { type: 'integer' },
    },
    AUTHOR,
  );
  await host.execute(
    { type: 'removeField', model: 'Chore', field: 'notes' },
    OK,
  );
  await host.execute(
    {
      type: 'changeFieldType',
      model: 'Chore',
      field: 'points',
      to: { type: 'integer' },
    },
    OK,
  );
  await host.execute(
    {
      type: 'addMethod',
      model: 'Chore',
      name: 'm',
      method: { description: 'x', code: 'return 1;' },
    },
    OK,
  );
  return { host, store };
}

describe('undoTo', () => {
  it('goes back several versions at once; a type change needs one approval', async () => {
    const { host } = await build();
    try {
      expect(host.version).toBe(5);
      const plan = await host.plan({ type: 'undoTo', version: 1 });
      expect(plan.risky).toBe(true);
      expect(plan.preview).toMatchObject({
        to: 1,
        versions: [
          { version: 5 },
          { version: 4 },
          { version: 3 },
          { version: 2 },
        ],
      });
      expect(plan.preview?.fields).toEqual([
        { model: 'Chore', field: 'points', rows: 0 },
      ]);
      // not approved: nothing changes
      await expect(
        host.execute({ type: 'undoTo', version: 1 }, AUTHOR),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
      expect(host.version).toBe(5);
      const r = await host.execute({ type: 'undoTo', version: 1 }, OK);
      expect(r).toMatchObject({ version: 1 });
      expect(host.version).toBe(1);
      const rows = await host.list('Chore');
      expect(rows.find((x) => x.title === 'a')).toMatchObject({
        notes: 'note a',
        points: '3',
      });
      expect(rows.find((x) => x.title === 'b')).toMatchObject({
        notes: 'note b',
        points: 'lots',
      });
      expect(host.def.models.Chore.fields.size).toBeUndefined();
      const vs = await host.versions();
      expect(vs.find((v) => v.current)?.version).toBe(1);
    } finally {
      await host.close();
    }
  });

  it('counts the values a type change would overwrite', async () => {
    const { host } = await build();
    try {
      const rows = await host.list('Chore');
      await host.update('Chore', rows[0].id as string, { points: 99 });
      const plan = await host.plan({ type: 'undoTo', version: 3 });
      expect(plan.preview?.replaced).toBe(1);
    } finally {
      await host.close();
    }
  });

  it('needs no approval when no step converts a column', async () => {
    const { host } = await build();
    try {
      const plan = await host.plan({ type: 'undoTo', version: 4 });
      expect(plan.risky).toBe(false);
      // v5 -> v4: only the method comes off
      await host.execute({ type: 'undoTo', version: 4 }, AUTHOR);
      expect(host.version).toBe(4);
      // v4 -> v2 converts: risky
      await expect(
        host.execute({ type: 'undoTo', version: 2 }, AUTHOR),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
      expect(host.version).toBe(4);
    } finally {
      await host.close();
    }
  });

  it('refuses the current version, an unknown one, one off the current path, and a stale pin', async () => {
    const { host } = await build();
    try {
      for (const cmd of [
        { type: 'undoTo', version: 5 },
        { type: 'undoTo', version: 99 },
        { type: 'undoTo', version: 1.5 },
        { type: 'undoTo', version: 1, from: 4 },
      ] as const)
        await expect(host.execute(cmd, OK)).rejects.toMatchObject({
          code: expect.stringMatching(/refused|invalid/),
        });
      expect(host.version).toBe(5);
      // go back to 3: 4 and 5 are in the store but off the path now
      await host.execute({ type: 'undoTo', version: 3 }, OK);
      await expect(
        host.execute({ type: 'undoTo', version: 5 }, OK),
      ).rejects.toMatchObject({ code: 'refused' });
      // a pinned undo to the right place works
      await host.execute({ type: 'undoTo', version: 2, from: 3 }, OK);
      expect(host.version).toBe(2);
      expect(host.version).toBe(2);
    } finally {
      await host.close();
    }
  });

  it('refuses a span that includes a purged version, changing nothing', async () => {
    const { host } = await build();
    try {
      // keep the last 2 changes: v1..v3's archives are purged
      await host.execute({ type: 'cleanUp', keep: 2 }, OK);
      await expect(
        host.execute({ type: 'undoTo', version: 1 }, OK),
      ).rejects.toThrow(/cleaned up/);
      expect(host.version).toBe(5);
      // the recent ones still go back
      await host.execute({ type: 'undoTo', version: 3 }, OK);
      expect(host.version).toBe(3);
    } finally {
      await host.close();
    }
  });

  it('a failure part-way leaves the app at the version it reached, and says so', async () => {
    const store = new MemoryVersionStore();
    const { host } = await build(store);
    try {
      const real = store.setCurrent.bind(store);
      let calls = 0;
      store.setCurrent = async (v: number) => {
        if (++calls === 2) throw new Error('store went away');
        return real(v);
      };
      await expect(
        host.execute({ type: 'undoTo', version: 1 }, OK),
      ).rejects.toThrow(/undid 1 of 4 changes.*version 4.*store went away/);
      // consistent at version 4: the method is gone, the type change is still applied
      expect(host.version).toBe(4);
      expect(host.def.models.Chore.methods).toEqual({});
      expect(await store.current()).toBe(4);
      expect(
        (await host.list('Chore')).find((x) => x.title === 'a')?.points,
      ).toBe(3);
      store.setCurrent = real;
      await host.execute({ type: 'undoTo', version: 1 }, OK);
      expect(host.version).toBe(1);
    } finally {
      await host.close();
    }
  });
});
