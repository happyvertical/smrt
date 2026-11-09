// The 26 checks of the spike's migrate-demo, against the host API.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppHost,
  type Command,
  EngineError,
  MemoryVersionStore,
} from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-migrate-'));
const store = new MemoryVersionStore();
let host: AppHost;

const sql = (q: string): string => {
  const db = new DatabaseSync(join(dir, 'app.db'), { readOnly: true });
  try {
    const row = db.prepare(q).get() as Record<string, unknown> | undefined;
    return row ? String(Object.values(row)[0]) : '';
  } finally {
    db.close();
  }
};
const cols = (table: string) =>
  sql(
    `select group_concat(name, ',') from pragma_table_info('${table}')`,
  ).split(',');
const run = (cmd: Command, approved = true) =>
  host.execute(cmd, { author: 'test', approved });
const toolProps = async (name: string) => {
  const t = (await host.appTools()).find((x) => x.name === name);
  return Object.keys(
    ((t?.inputSchema as { properties?: object })?.properties ?? {}) as object,
  );
};

const ids: string[] = [];
let late = '';

beforeAll(async () => {
  host = await AppHost.open(dir, { store });
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations (sequential, one app)', () => {
  it('sets up the Chore model and four records', async () => {
    await run({
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text', required: true },
        points: { type: 'text' },
        done: { type: 'boolean' },
        notes: { type: 'text' },
      },
    });
    for (const [title, points, notes] of [
      ['Bins', '3', 'blue bin'],
      ['Dishes', '5', null],
      ['Garage', 'lots', 'big job'],
      ['Lawn', null, null],
    ] as const)
      ids.push(
        (await host.create('Chore', { title, points, notes })).id as string,
      );
    expect(ids).toHaveLength(4);
  });

  it('1-3 changeFieldType text -> integer: preview, convert, empty the bad value', async () => {
    const cmd: Command = {
      type: 'changeFieldType',
      model: 'Chore',
      field: 'points',
      to: { type: 'integer' },
    };
    const plan = await host.plan(cmd);
    expect(plan.risky).toBe(true);
    expect((plan.preview as { failingCount: number }).failingCount).toBe(1);
    expect(
      (plan.preview as { failing: { value: string }[] }).failing[0].value,
    ).toBe('lots');
    await run(cmd);
    expect(
      sql(`select type from pragma_table_info('u_chores') where name='points'`),
    ).toBe('INTEGER');
    expect(
      sql(
        `select group_concat(coalesce(points,'null'),',') from (select points from u_chores order by title)`,
      ),
    ).toBe('3,5,null,null');
    late = (await host.create('Chore', { title: 'Windows', points: 7 }))
      .id as string;
  });

  it('4-5 renameField keeps data and renames the generated tool parameter', async () => {
    await run({
      type: 'renameField',
      model: 'Chore',
      from: 'title',
      to: 'name',
    });
    expect(sql(`select name from u_chores where id='${ids[0]}'`)).toBe('Bins');
    const props = await toolProps('chore_create');
    expect(props).toContain('name');
    expect(props).not.toContain('title');
  });

  it('6-9 removeField archives the values, drops the column, updates the tools', async () => {
    const cmd: Command = {
      type: 'removeField',
      model: 'Chore',
      field: 'notes',
    };
    const plan = await host.plan(cmd);
    expect((plan.preview as { valuesArchived: number }).valuesArchived).toBe(2);
    await run(cmd);
    expect(cols('u_chores')).not.toContain('notes');
    expect(sql(`select count(*) from _archive where col='notes'`)).toBe('2');
    expect(await toolProps('chore_update')).not.toContain('notes');
  });

  it('10 a subclass field on the shipped Profile table renames and keeps its value', async () => {
    await run({ type: 'enableRecipe', recipe: 'profiles' });
    await run({
      type: 'addField',
      model: 'Profile',
      field: 'nickname',
      definition: { type: 'text' },
    });
    await host.create('Profile', { name: 'Sam', nickname: 'Sammy' });
    await run({
      type: 'renameField',
      model: 'Profile',
      from: 'nickname',
      to: 'callMe',
    });
    expect(cols('profiles')).toContain('call_me');
    expect((await host.list('Profile'))[0].callMe).toBe('Sammy');
  });

  it('11-12 removeModel moves the table aside and drops its tools', async () => {
    await run({
      type: 'defineModel',
      name: 'Errand',
      fields: { what: { type: 'text' } },
    });
    await host.create('Errand', { what: 'post office' });
    const plan = await host.plan({ type: 'removeModel', model: 'Errand' });
    expect((plan.preview as { rows: number }).rows).toBe(1);
    await run({ type: 'removeModel', model: 'Errand' });
    expect(
      sql(
        `select count(*) from sqlite_master where name like '_archived_u_errands_%'`,
      ),
    ).toBe('1');
    expect(
      sql(`select count(*) from sqlite_master where name='u_errands'`),
    ).toBe('0');
    expect(
      (await host.appTools()).some((t) => t.name.startsWith('errand_')),
    ).toBe(false);
  });

  it('13-16 a failing migration is refused, rolled back, and the app keeps running', async () => {
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'extra',
      definition: { type: 'text' },
    });
    await run({ type: 'undo' }, false); // leaves an orphan 'extra' column behind
    const before = host.version;
    await expect(
      run({ type: 'renameField', model: 'Chore', from: 'name', to: 'extra' }),
    ).rejects.toBeInstanceOf(EngineError);
    expect(host.version).toBe(before);
    expect(await store.current()).toBe(before);
    expect(await host.list('Chore')).toHaveLength(5);
    expect(cols('u_chores')).toContain('name');
    expect(host.appAlive).toBe(true);
  });

  it('17 restart: state is intact', async () => {
    await host.close();
    host = await AppHost.open(dir, { store });
    expect((await host.get('Chore', ids[0])).name).toBe('Bins');
  });

  it('18-24 undo walks back through every kind of step', async () => {
    const undo = () => host.execute({ type: 'undo' }, { author: 'test' });
    await undo(); // remove model Errand
    expect(sql(`select what from u_errands`)).toBe('post office');
    await undo(); // define Errand
    await undo(); // rename nickname -> callMe
    expect((await host.list('Profile'))[0].nickname).toBe('Sammy');
    await undo(); // add nickname
    await undo(); // enable profiles
    await undo(); // remove notes
    expect(sql(`select notes from u_chores where id='${ids[0]}'`)).toBe(
      'blue bin',
    );
    expect(sql(`select count(*) from _archive where col='notes'`)).toBe('0');
    await undo(); // rename title -> name
    expect(cols('u_chores')).toContain('title');
    expect(cols('u_chores')).not.toContain('name');
    await undo(); // change type
    expect(sql(`select points from u_chores where id='${ids[2]}'`)).toBe(
      'lots',
    );
    expect(
      sql(`select type from pragma_table_info('u_chores') where name='points'`),
    ).toBe('TEXT');
    expect(sql(`select points from u_chores where id='${late}'`)).toBe('7');
    const t = (await host.appTools()).find((x) => x.name === 'chore_create');
    const schema = t?.inputSchema as {
      properties?: Record<string, { $ref?: string }>;
      $defs?: Record<string, unknown>;
    };
    const p = schema.properties?.points;
    const resolved = p?.$ref
      ? schema.$defs?.[p.$ref.split('/').pop() as string]
      : p;
    expect(JSON.stringify(resolved ?? {})).toContain('"string"');
  });

  it('25-26 cleanUp makes old changes permanent; undo past one is refused', async () => {
    await run({ type: 'removeField', model: 'Chore', field: 'notes' });
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'room',
      definition: { type: 'text' },
    });
    const cu = (await run({ type: 'cleanUp', keep: 1 })) as {
      purgedVersions: number[];
    };
    expect(cu.purgedVersions.length).toBeGreaterThanOrEqual(1);
    expect(sql(`select count(*) from _archive where col='notes'`)).toBe('0');
    await host.execute({ type: 'undo' }, { author: 'test' }); // room: additive, fine
    await expect(
      host.execute({ type: 'undo' }, { author: 'test' }),
    ).rejects.toThrow(/cleaned up/);
    const v = (await host.versions()).find((x) => x.purged);
    expect(v).toBeTruthy();
  });
});
