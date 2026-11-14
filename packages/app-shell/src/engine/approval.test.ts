import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
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
      'extractModel',
      'loadRecords',
      'mergeRecords',
      'removeField',
      'removeModel',
      'removeReport',
      'setCalculation',
    ]);
    expect(isRiskyTool('chore_delete')).toBe(true);
    expect(isRiskyTool('chore_list')).toBe(false);
    // undo's risk comes from the stored version (see hardening.test.ts)
    expect(isRiskyCommand({ type: 'undo' })).toBe(false);
    expect(
      isRiskyCommand({
        type: 'loadRecords',
        model: 'Chore',
        mode: 'upsert',
        key: ['title'],
        rows: [],
      }),
    ).toBe(true);
    expect(
      isRiskyCommand({
        type: 'loadRecords',
        model: 'Chore',
        mode: 'insert',
        rows: [],
      }),
    ).toBe(true);
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

describe('data and definition approval policy', () => {
  it('requires approval for insert and no-update upsert loads', async () => {
    for (const mode of ['insert', 'upsert'] as const) {
      const cmd = {
        type: 'loadRecords' as const,
        model: 'Chore',
        mode,
        key: mode === 'upsert' ? ['title'] : undefined,
        rows: [{ title: `approval-${mode}` }],
      };
      const version = host.version;
      expect((await host.plan(cmd)).risky).toBe(true);
      await expect(host.execute(cmd, asked)).rejects.toBeInstanceOf(
        ApprovalRequiredError,
      );
      expect(host.version).toBe(version);
      await host.execute(cmd, ok);
    }
  });
  it('requires approval when replacing and clearing an existing calculation', async () => {
    await host.execute(
      {
        type: 'addField',
        model: 'Chore',
        field: 'calculatedPoints',
        definition: { type: 'integer', calculated: { value: 1 } },
      },
      asked,
    );
    for (const calculated of [{ value: 2 }, null]) {
      const cmd = {
        type: 'setCalculation' as const,
        model: 'Chore',
        field: 'calculatedPoints',
        calculated,
      };
      expect((await host.plan(cmd)).risky).toBe(true);
      await expect(host.execute(cmd, asked)).rejects.toBeInstanceOf(
        ApprovalRequiredError,
      );
      await host.execute(cmd, ok);
    }
  });
});

it('requires approval for report removal while rename remains immediate', async () => {
  await host.execute(
    {
      type: 'defineReport',
      name: 'chores',
      definition: {
        spec: parseRuntimeReportSpec({
          version: 1,
          title: 'Chores',
          dimensions: [],
          source: 'Chore',
          measures: [{ fn: 'count', as: 'count' }],
        }),
      },
    },
    asked,
  );
  expect(
    (await host.plan({ type: 'renameReport', from: 'chores', to: 'renamed' }))
      .risky,
  ).toBe(false);
  await host.execute(
    { type: 'renameReport', from: 'chores', to: 'renamed' },
    asked,
  );
  const cmd = { type: 'removeReport' as const, name: 'renamed' };
  expect((await host.plan(cmd)).risky).toBe(true);
  await expect(host.execute(cmd, asked)).rejects.toBeInstanceOf(
    ApprovalRequiredError,
  );
  expect(host.def.reports?.renamed).toBeDefined();
  await host.execute(cmd, ok);
  expect(host.def.reports?.renamed).toBeUndefined();
});

it('refuses approved loads whose current updates exceed reviewed bounds', async () => {
  const cmd: Command = {
    type: 'loadRecords',
    model: 'Chore',
    mode: 'upsert',
    key: ['title'],
    rows: [{ title: 'stale-load', points: 2 }],
  };
  const reviewed = await host.plan(cmd);
  const row = await host.create('Chore', {
    title: 'stale-load',
    points: 1,
  });
  const before = host.version;
  await expect(
    host.execute(cmd, { ...ok, reviewedPreview: reviewed.preview }),
  ).rejects.toBeInstanceOf(ApprovalRequiredError);
  expect(host.version).toBe(before);
  expect((await host.get('Chore', row.id as string)).points).toBe(1);
  const fresh = await host.plan(cmd);
  const result = await host.execute(cmd, {
    ...ok,
    reviewedPreview: fresh.preview,
  });
  expect(result).toMatchObject({
    loadCounts: { insert: 0, update: 1, unchanged: 0, rejected: 0 },
  });
});
