import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppHost,
  ApprovalRequiredError,
  type Command,
  isRiskyCommand,
  isRiskyTool,
  MemoryVersionStore,
  RISKY_COMMANDS,
  type Template,
} from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-approval-'));
const store = new MemoryVersionStore();
let host: AppHost;
let choreId = '';
const ok = { author: 't', approved: true };
const asked = { author: 't' };

beforeAll(async () => {
  host = await AppHost.open(dir, { store });
  await host.execute(
    {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text' },
        points: { type: 'text' },
        notes: { type: 'text' },
      },
    },
    asked,
  );
  await host.execute(
    { type: 'defineModel', name: 'Errand', fields: { what: { type: 'text' } } },
    asked,
  );
  choreId = (
    await host.create('Chore', { title: 'a', points: '1', notes: 'n' })
  ).id as string;
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const risky: [string, () => Command][] = [
  [
    'addMethod',
    () => ({
      type: 'addMethod',
      model: 'Chore',
      name: 'hello',
      method: { description: 'hi', code: 'return 1;' },
    }),
  ],
  [
    'removeField',
    () => ({ type: 'removeField', model: 'Chore', field: 'notes' }),
  ],
  [
    'changeFieldType',
    () => ({
      type: 'changeFieldType',
      model: 'Chore',
      field: 'points',
      to: { type: 'integer' },
    }),
  ],
  ['removeModel', () => ({ type: 'removeModel', model: 'Errand' })],
  ['cleanUp', () => ({ type: 'cleanUp', keep: 0 })],
];

describe('approval gate', () => {
  it('lists the risky commands in one place', () => {
    expect([...RISKY_COMMANDS].sort()).toEqual([
      'addMethod',
      'changeFieldType',
      'cleanUp',
      'removeField',
      'removeModel',
    ]);
    expect(isRiskyTool('chore_delete')).toBe(true);
    expect(isRiskyTool('chore_list')).toBe(false);
    expect(isRiskyCommand({ type: 'undo' })).toBe(false);
  });

  for (const [name, make] of risky) {
    it(`${name} is refused without approval, changes nothing, and works with it`, async () => {
      const before = {
        version: host.version,
        def: structuredClone(host.def),
        versions: (await host.versions()).length,
      };
      const plan = await host.plan(make());
      expect(plan.risky).toBe(true);
      expect(host.version).toBe(before.version); // planning changes nothing
      const err = await host.execute(make(), asked).catch((e) => e);
      expect(err).toBeInstanceOf(ApprovalRequiredError);
      expect((err as ApprovalRequiredError).plan.risky).toBe(true);
      expect((err as ApprovalRequiredError).plan.summary).toBe(plan.summary);
      await expect(
        host.execute(make(), { author: 't', approved: false }),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
      expect(host.version).toBe(before.version);
      expect(host.def).toEqual(before.def);
      expect((await host.versions()).length).toBe(before.versions);
      expect(await store.current()).toBe(before.version);

      await host.execute(make(), ok);
      if (name !== 'cleanUp') expect(host.version).toBe(before.version + 1);
    });
  }

  it('non-risky commands run without approval', async () => {
    const plan = await host.plan({
      type: 'addField',
      model: 'Chore',
      field: 'room',
      definition: { type: 'text' },
    });
    expect(plan.risky).toBe(false);
    await host.execute(
      {
        type: 'addField',
        model: 'Chore',
        field: 'room',
        definition: { type: 'text' },
      },
      asked,
    );
    await host.execute({ type: 'undo' }, asked);
  });

  it('the plan previews counts without changing anything', async () => {
    await host.execute(
      { type: 'defineModel', name: 'Chore2', fields: { a: { type: 'text' } } },
      asked,
    );
    await host.create('Chore2', { a: 'x' });
    await host.create('Chore2', { a: 'y' });
    const p = await host.plan({ type: 'removeModel', model: 'Chore2' });
    expect((p.preview as { rows: number }).rows).toBe(2);
    expect((await host.list('Chore2')).length).toBe(2);
  });

  it('a generated delete tool needs approval; the record survives a refusal', async () => {
    const err = await host
      .callAppTool('chore_delete', { id: choreId })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect(await host.get('Chore', choreId)).toBeTruthy();
    const r = await host.callAppTool(
      'chore_delete',
      { id: choreId },
      { approved: true },
    );
    expect(r.isError).toBe(false);
    await expect(host.get('Chore', choreId)).rejects.toThrow(/no Chore/);
  });

  it('a REST DELETE needs approval too', async () => {
    const c = await host.create('Chore', { title: 'z' });
    await expect(
      host.rest({ method: 'DELETE', url: `/api/chores/${c.id}` }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(await host.get('Chore', c.id as string)).toBeTruthy();
    const r = await host.rest(
      { method: 'DELETE', url: `/api/chores/${c.id}` },
      { approved: true },
    );
    expect(r.status).toBeLessThan(300);
  });

  it('importing a template with method code needs approval', async () => {
    const other = await AppHost.open(
      mkdtempSync(join(tmpdir(), 'engine-approval-imp-')),
      {
        store: new MemoryVersionStore(),
      },
    );
    try {
      const tpl = (await host.execute(
        { type: 'exportTemplate' },
        asked,
      )) as Template;
      expect(Object.keys(tpl.definition.models.Chore.methods ?? {})).toContain(
        'hello',
      );
      const cmd: Command = { type: 'importTemplate', data: tpl };
      expect(isRiskyCommand(cmd)).toBe(true);
      await expect(other.execute(cmd, asked)).rejects.toBeInstanceOf(
        ApprovalRequiredError,
      );
      expect(other.version).toBe(0);
      await other.execute(cmd, ok);
      expect(other.version).toBe(1);
      // without code it is not risky
      const plain = structuredClone(tpl);
      for (const m of Object.values(plain.definition.models)) m.methods = {};
      expect(isRiskyCommand({ type: 'importTemplate', data: plain })).toBe(
        false,
      );
    } finally {
      await other.close();
    }
  });

  it('execute needs an author', async () => {
    await expect(host.execute({ type: 'undo' }, {} as never)).rejects.toThrow(
      /author/,
    );
  });
});
