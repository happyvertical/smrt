import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import {
  AppHost,
  ApprovalRequiredError,
  type Command,
  MemoryVersionStore,
} from './index.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'safety-round4-'));
  const host = await AppHost.open(dir, { store: new MemoryVersionStore() });
  const run = (cmd: Command) =>
    host.execute(cmd, { author: 't', approved: true });
  await run({
    type: 'defineModel',
    name: 'Sale',
    fields: { input: { type: 'number' }, value: { type: 'number' } },
  });
  const raw = () => {
    const db = new DatabaseSync(join(dir, 'app.db'));
    try {
      return db.prepare('SELECT * FROM u_sales ORDER BY id').all();
    } finally {
      db.close();
    }
  };
  return {
    host,
    run,
    raw,
    close: async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it.each([
  'setCalculation',
  'replaceCalculation',
  'clearCalculation',
  'removeField',
  'changeFieldType',
  'changeCalculatedType',
] as const)('refreshes reviewed %s counts before any writes', async (operation) => {
  const f = await fixture();
  try {
    const generated = [
      'replaceCalculation',
      'clearCalculation',
      'changeCalculatedType',
    ].includes(operation);
    if (operation === 'changeCalculatedType')
      await f.run({
        type: 'changeFieldType',
        model: 'Sale',
        field: 'input',
        to: { type: 'integer' },
      });
    if (generated)
      await f.run({
        type: 'setCalculation',
        model: 'Sale',
        field: 'value',
        calculated: { col: 'input' },
      });
    const cmd: Command = [
      'setCalculation',
      'replaceCalculation',
      'clearCalculation',
    ].includes(operation)
      ? {
          type: 'setCalculation',
          model: 'Sale',
          field: 'value',
          calculated:
            operation === 'clearCalculation' ? null : { col: 'input' },
        }
      : operation === 'removeField'
        ? { type: 'removeField', model: 'Sale', field: 'value' }
        : {
            type: 'changeFieldType',
            model: 'Sale',
            field: 'value',
            to: { type: 'integer' },
          };
    const reviewed = await f.host.plan(cmd);
    await f.host.create(
      hostOwner(f.host),
      'Sale',
      generated ? { input: 3 } : { input: 3, value: 2 },
    );
    const before = f.raw();
    const version = f.host.version;
    const definition = structuredClone(f.host.def);
    let error: unknown;
    try {
      await f.host.execute(cmd, {
        author: 't',
        approved: true,
        reviewedPreview: reviewed.preview,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ApprovalRequiredError);
    expect((error as ApprovalRequiredError).plan.preview).toEqual(
      (await f.host.plan(cmd)).preview,
    );
    expect(f.raw()).toEqual(before);
    expect(f.host.version).toBe(version);
    expect(f.host.def).toEqual(definition);
    const fresh = await f.host.plan(cmd);
    await f.host.execute(cmd, {
      author: 't',
      approved: true,
      reviewedPreview: fresh.preview,
    });
    expect(f.host.version).toBeGreaterThan(version);
  } finally {
    await f.close();
  }
});

it('refuses rejected rows during planning with actionable row and field detail', async () => {
  const f = await fixture();
  try {
    const version = f.host.version;
    await expect(
      f.host.plan({
        type: 'loadRecords',
        model: 'Sale',
        mode: 'insert',
        rows: [{ unknown: 1 }],
      }),
    ).rejects.toThrow(/rejected 1 rows; no rows loaded: row 1 unknown/);
    expect(f.raw()).toEqual([]);
    expect(f.host.version).toBe(version);
    expect(
      (
        await f.host.plan({
          type: 'loadRecords',
          model: 'Sale',
          mode: 'insert',
          rows: [{ input: 1 }],
        })
      ).preview,
    ).toMatchObject({ insert: 1, rejected: 0 });
  } finally {
    await f.close();
  }
});

it.each([
  0.1 + 0.2,
  1.2345678901234567,
])('preserves the exact SQLite double %s when clearing and undoing', async (value) => {
  const f = await fixture();
  try {
    const row = await f.host.create(hostOwner(f.host), 'Sale', {
      input: value,
    });
    await f.run({
      type: 'setCalculation',
      model: 'Sale',
      field: 'value',
      calculated: { col: 'input' },
    });
    expect(
      (await f.host.get(hostOwner(f.host), 'Sale', String(row.id))).value,
    ).toBe(value);
    await f.run({
      type: 'setCalculation',
      model: 'Sale',
      field: 'value',
      calculated: null,
    });
    expect(
      (await f.host.get(hostOwner(f.host), 'Sale', String(row.id))).value,
    ).toBe(value);
    await f.run({ type: 'undo' });
    expect(
      (await f.host.get(hostOwner(f.host), 'Sale', String(row.id))).value,
    ).toBe(value);
  } finally {
    await f.close();
  }
});

it('refuses merge undo that would restore a reference to a subsequently deleted target atomically', async () => {
  const f = await fixture();
  try {
    await f.run({
      type: 'defineModel',
      name: 'Team',
      fields: { name: { type: 'text' } },
    });
    await f.run({
      type: 'addField',
      model: 'Sale',
      field: 'team',
      definition: { type: 'reference', ref: 'Team' },
    });
    const team = await f.host.create(hostOwner(f.host), 'Team', {
      name: 'Deleted team',
    });
    const keep = await f.host.create(hostOwner(f.host), 'Sale', { input: 1 });
    const merged = await f.host.create(hostOwner(f.host), 'Sale', {
      input: 2,
      team: team.id,
    });
    await f.run({
      type: 'mergeRecords',
      model: 'Sale',
      keep: String(keep.id),
      merge: [String(merged.id)],
    });
    await f.host.remove(hostOwner(f.host), 'Team', String(team.id));
    const before = f.raw();
    const version = f.host.version;
    await expect(f.run({ type: 'undo' })).rejects.toThrow(/reference|target/i);
    expect(f.raw()).toEqual(before);
    expect(f.host.version).toBe(version);
  } finally {
    await f.close();
  }
});
