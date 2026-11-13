// An end-to-end walk through the engine, after the spike's demo.ts.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { toRuntimeModel } from './definition.ts';
import {
  type AppDefinition,
  AppHost,
  ApprovalRequiredError,
  type Command,
  EngineError,
  MemoryVersionStore,
  type Template,
} from './index.ts';

const dirs: string[] = [];
const hosts: AppHost[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'engine-walk-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const h of hosts) await h.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const dir = tmp();
const store = new MemoryVersionStore();
const events: string[] = [];
let host: AppHost;
const run = (cmd: Command, approved = true) =>
  host.execute(cmd, { author: 'walk', approved });
const toolNames = async () => (await host.appTools()).map((t) => t.name);
const sql = (file: string, q: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(q).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
};

describe('walk-through', () => {
  let c1 = '';
  let c2 = '';

  it('defines a model and gets its generated tools', async () => {
    host = await AppHost.open(dir, { store });
    hosts.push(host);
    host.on('changed', (e) => events.push(`changed:${e.summary}`));
    host.on('records', (e) => events.push(`records:${e.model}`));
    expect(host.describe().models).toEqual({});
    await run({
      type: 'defineModel',
      name: 'Chore',
      label: 'Chores',
      fields: {
        title: { type: 'text', required: true },
        due: { type: 'date' },
        done: { type: 'boolean' },
      },
    });
    expect(await toolNames()).toEqual(
      expect.arrayContaining([
        'chore_list',
        'chore_get',
        'chore_create',
        'chore_update',
        'chore_delete',
      ]),
    );
    expect(events).toContain('changed:define Chore');
  });

  it('creates, lists, updates and validates records', async () => {
    c1 = (
      await host.create('Chore', {
        title: 'Take out the bins',
        due: '2026-11-13T18:00:00Z',
      })
    ).id as string;
    c2 = (await host.create('Chore', { title: 'Empty the dishwasher' }))
      .id as string;
    expect(await host.list('Chore')).toHaveLength(2);
    expect((await host.get('Chore', c1)).due).toBe('2026-11-13T18:00:00.000Z');
    await expect(
      host.create('Chore', { title: 'x', mood: 'happy' }),
    ).rejects.toThrow(/no field 'mood'/);
    await expect(host.create('Chore', {})).rejects.toThrow(/title is required/);
    await expect(
      host.create('Chore', { title: 'x', done: 'maybe' }),
    ).rejects.toThrow(/true or false/);
    expect(events).toContain('records:Chore');
  });

  it('lists through the worker generated REST', async () => {
    const r = await host.rest({ method: 'GET', url: '/api/chores' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toHaveLength(2);
    const post = await host.rest({
      method: 'POST',
      url: '/api/chores',
      body: JSON.stringify({ title: 'via rest' }),
    });
    expect(post.status).toBeLessThan(300);
    expect(await host.list('Chore')).toHaveLength(3);
  });

  it('adds a field; the existing field cannot be re-added', async () => {
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'points',
      definition: { type: 'integer' },
    });
    await expect(
      run({
        type: 'addField',
        model: 'Chore',
        field: 'points',
        definition: { type: 'text' },
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('adds a method (approved) and runs it through runMethod and the generated tool', async () => {
    await run({
      type: 'addMethod',
      model: 'Chore',
      name: 'complete',
      method: {
        description: 'Mark this chore done',
        code: `if (!record) throw new Error('open a chore first'); app.update('Chore', record.id, { done: true }); return 'done: ' + record.title;`,
      },
    });
    expect(await toolNames()).toContain('chore_complete');
    const out = await host.runMethod('Chore', 'complete', c1);
    expect(out.result).toBe('done: Take out the bins');
    expect(out.applied).toBe(1);
    expect(out.snapshot && existsSync(out.snapshot)).toBe(true);
    expect((await host.get('Chore', c1)).done).toBe(true);

    const viaTool = await host.callAppTool('chore_complete', { id: c2 });
    expect(viaTool.isError).toBe(false);
    expect((await host.get('Chore', c2)).done).toBe(true);
  });

  it('runs a read-only method that returns a result and writes nothing', async () => {
    await run({
      type: 'addMethod',
      model: 'Chore',
      name: 'score',
      method: {
        description: 'Points of done chores',
        code: `return data.Chore.filter((c) => c.done).length + params.bonus;`,
        params: { bonus: { type: 'integer', required: true } },
      },
    });
    const out = await host.runMethod('Chore', 'score', null, { bonus: 10 });
    expect(out.result).toBe(12);
    expect(out.applied).toBe(0);
    expect(out.snapshot).toBeNull();
    await expect(host.runMethod('Chore', 'score', null, {})).rejects.toThrow(
      /bonus is required/,
    );
  });

  it('hides a field and undoes back; the tools follow the definition', async () => {
    await run({ type: 'hideField', model: 'Chore', field: 'due' });
    expect(Object.keys(await host.get('Chore', c1))).not.toContain('due');
    await run({ type: 'undo' });
    expect(Object.keys(await host.get('Chore', c1))).toContain('due');
    await run({ type: 'undo' }); // score
    await run({ type: 'undo' }); // complete
    expect(await toolNames()).not.toContain('chore_complete');
    await expect(host.runMethod('Chore', 'complete', c1)).rejects.toThrow(
      /no method/,
    );
    expect((await host.versions()).filter((v) => v.current)).toHaveLength(1);
  });

  it('turns on profiles: an app subclass, find-or-create person type, real parent sees records', async () => {
    await run({ type: 'enableRecipe', recipe: 'profiles' });
    const def = host.def;
    expect(def.recipes).toEqual(['profiles']);
    expect(def.models.Profile.extends).toBe(
      '@happyvertical/smrt-profiles:Profile',
    );
    expect(def.models.Profile.fields).toEqual({});
    await run({
      type: 'addField',
      model: 'Profile',
      field: 'nickname',
      definition: { type: 'text' },
    });
    await run({
      type: 'addField',
      model: 'Chore',
      field: 'assignee',
      definition: { type: 'reference', ref: 'Profile', label: 'Who' },
    });
    const sam = await host.create('Profile', {
      name: 'Sam',
      nickname: 'Sammy',
    });
    await host.create('Profile', { name: 'Alex' });
    expect(sam.nickname).toBe('Sammy');
    await host.update('Chore', c1, { assignee: sam.id });
    await expect(
      host.update('Chore', c1, { assignee: 'nope' }),
    ).rejects.toThrow(/no Profile with id/);

    const file = join(dir, 'app.db');
    const rows = sql(
      file,
      'select id, _meta_type, nickname, type_id from profiles order by name',
    );
    expect(rows).toHaveLength(2);
    // the subclass has its own _meta_type, distinct from the shipped parent
    expect(rows[0]._meta_type).toBe('@local/app:Profile');
    expect(rows[0]._meta_type).not.toBe('@happyvertical/smrt-profiles:Profile');
    // one real person type, shared by both
    expect(
      sql(
        file,
        `select count(*) as n from profile_types where slug = 'person'`,
      )[0].n,
    ).toBe(1);
    expect(rows[0].type_id).toBe(rows[1].type_id);

    // The real parent collection still sees records made through the subclass.
    const { ObjectRegistry, registerRuntimeModel } = await import(
      '@happyvertical/smrt-core'
    );
    await import('@happyvertical/smrt-profiles');
    const { getDatabase } = await import('@happyvertical/sql');
    registerRuntimeModel(toRuntimeModel('Profile', def.models.Profile));
    const db = await getDatabase({ type: 'sqlite', url: file } as never);
    const parent = await ObjectRegistry.getCollection(
      '@happyvertical/smrt-profiles:Profile',
      { db },
    );
    const seen = await parent.list({});
    expect(seen).toHaveLength(2);
    expect(
      seen.map((p) => (p as unknown as { name: string }).name).sort(),
    ).toEqual(['Alex', 'Sam']);
    // the generated tools of the app are the subclass's, not the shipped Profile's
    // (one profile_create, not a duplicate from the shipped parent)
    const names = await toolNames();
    expect(names.filter((n: string) => n === 'profile_create')).toHaveLength(1);
  });

  it('refuses to remove a recipe model, and to touch built-in fields', async () => {
    await expect(
      run({ type: 'removeModel', model: 'Profile' }),
    ).rejects.toThrow(/belongs to a recipe/);
    await expect(
      run({
        type: 'addField',
        model: 'Profile',
        field: 'email',
        definition: { type: 'text' },
      }),
    ).rejects.toThrow(/built in/);
    await expect(
      run({ type: 'renameField', model: 'Profile', from: 'name', to: 'label' }),
    ).rejects.toThrow(/built in/);
  });

  let template: Template;
  it('exports a template with records', async () => {
    await run({
      type: 'addMethod',
      model: 'Chore',
      name: 'complete',
      method: {
        description: 'Mark done',
        code: `app.update('Chore', record.id, { done: true }); return 1;`,
      },
    });
    template = (await run({
      type: 'exportTemplate',
      includeRecords: true,
    })) as Template;
    expect(template.format).toBe(1);
    expect(Object.keys(template.records ?? {}).sort()).toEqual([
      'Chore',
      'Profile',
    ]);
    const noRecords = (await run({ type: 'exportTemplate' })) as Template;
    expect(noRecords.records).toBeUndefined();
  });

  it('imports it into a new data folder and gets the same app', async () => {
    const other = await AppHost.open(tmp(), {
      store: new MemoryVersionStore(),
    });
    hosts.push(other);
    // the template carries method code, so importing it needs approval
    await expect(
      other.execute(
        { type: 'importTemplate', data: template },
        { author: 'imp' },
      ),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(other.version).toBe(0);
    await other.execute(
      { type: 'importTemplate', data: template },
      { author: 'imp', approved: true },
    );
    expect(other.def).toEqual(host.def);
    expect(other.describe().models).toEqual(host.describe().models);
    const chores = await other.list('Chore');
    expect(chores.map((c) => c.id).sort()).toEqual(
      (await host.list('Chore')).map((c) => c.id).sort(),
    );
    const sam = (await other.list('Profile')).find((p) => p.name === 'Sam');
    expect(sam?.nickname).toBe('Sammy');
    // references survive because ids are kept
    expect((await other.get('Chore', c1)).assignee).toBe(sam?.id);
    // a second import is refused: the app is not empty
    await expect(
      other.execute(
        { type: 'importTemplate', data: template },
        { author: 'imp', approved: true },
      ),
    ).rejects.toThrow(/empty app/);
  });

  it('rejects a bad template', async () => {
    const other = await AppHost.open(tmp(), {
      store: new MemoryVersionStore(),
    });
    hosts.push(other);
    const bad = { format: 2, definition: {} } as unknown as Template;
    await expect(
      other.execute({ type: 'importTemplate', data: bad }, { author: 'x' }),
    ).rejects.toThrow(/format/);
    const evil = structuredClone(template);
    (evil.definition as AppDefinition).models.Chore.methods = {
      complete: { description: 'x', code: '}); evil(); (function(){' },
    };
    await expect(
      other.execute(
        { type: 'importTemplate', data: evil },
        { author: 'x', approved: true },
      ),
    ).rejects.toThrow(/does not parse/);
    expect(other.version).toBe(0);
  });

  it('turning profiles off by undo and on again keeps the shipped table and its data', async () => {
    const h = await AppHost.open(tmp(), { store: new MemoryVersionStore() });
    hosts.push(h);
    const go = (cmd: Command) =>
      h.execute(cmd, { author: 'x', approved: true });
    await go({ type: 'enableRecipe', recipe: 'profiles' });
    await go({
      type: 'addField',
      model: 'Profile',
      field: 'nickname',
      definition: { type: 'text' },
    });
    await h.create('Profile', { name: 'Sam', nickname: 'Sammy' });
    const rest = await h.rest({ method: 'GET', url: '/api/profiles' });
    expect(JSON.parse(rest.body)).toHaveLength(1);
    await go({ type: 'undo' });
    await go({ type: 'undo' });
    await expect(h.list('Profile')).rejects.toThrow(/no model/);
    await go({ type: 'enableRecipe', recipe: 'profiles' });
    await go({
      type: 'addField',
      model: 'Profile',
      field: 'nickname',
      definition: { type: 'text' },
    });
    expect((await h.list('Profile'))[0].nickname).toBe('Sammy');
  });

  it('keeps the history and swaps quickly', async () => {
    const versions = await host.versions();
    expect(versions[0]).toMatchObject({ version: 0, parent: null });
    expect(versions.at(-1)?.current).toBe(true);
    // sanity, not a hard budget
    expect(host.lastSwapMs).toBeLessThan(10_000);
    process.stderr.write(`last app swap: ${host.lastSwapMs} ms\n`);
  });

  it('refuses a stale-looking command on an unknown model', async () => {
    await expect(
      run({
        type: 'addField',
        model: 'Nope',
        field: 'x',
        definition: { type: 'text' },
      }),
    ).rejects.toBeInstanceOf(EngineError);
  });
});
