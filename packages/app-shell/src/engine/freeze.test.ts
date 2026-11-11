// Slice 1 of draft/publish: a frozen host refuses structure but serves records,
// and `autoApprove` exists only on a draft host.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Command,
  type CommandType,
  isStructuralCommand,
  STRUCTURAL_COMMANDS,
} from './commands.ts';
import { DRAFT_MARKER_FILE, writeDraftMarker } from './draft.ts';
import {
  AppHost,
  ApprovalRequiredError,
  EngineError,
  MemoryVersionStore,
} from './index.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-freeze-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One sample of every command type (the type makes the list exhaustive). */
const SAMPLES: Record<CommandType, Command> = {
  defineReport: {
    type: 'defineReport',
    name: 'counts',
    definition: { spec: {} as never },
  },
  renameReport: { type: 'renameReport', from: 'a', to: 'b' },
  removeReport: { type: 'removeReport', name: 'a' },
  defineModel: { type: 'defineModel', name: 'Other' },
  addField: {
    type: 'addField',
    model: 'Chore',
    field: 'notes',
    definition: { type: 'text' },
  },
  setCalculation: {
    type: 'setCalculation',
    model: 'Chore',
    field: 'title',
    calculated: null,
  },
  hideField: { type: 'hideField', model: 'Chore', field: 'title' },
  renameField: {
    type: 'renameField',
    model: 'Chore',
    from: 'title',
    to: 'name',
  },
  removeField: { type: 'removeField', model: 'Chore', field: 'title' },
  changeFieldType: {
    type: 'changeFieldType',
    model: 'Chore',
    field: 'title',
    to: { type: 'integer' },
  },
  removeModel: { type: 'removeModel', model: 'Chore' },
  addMethod: {
    type: 'addMethod',
    model: 'Chore',
    name: 'noop',
    method: { description: 'x', code: 'return 1;' },
  },
  enableRecipe: { type: 'enableRecipe', recipe: 'profiles' },
  undo: { type: 'undo' },
  undoTo: { type: 'undoTo', version: 0 },
  cleanUp: { type: 'cleanUp', keep: 0 },
  exportTemplate: { type: 'exportTemplate', includeRecords: true },
  importTemplate: {
    type: 'importTemplate',
    data: {
      format: 1,
      definition: { format: 1, models: {}, recipes: [] } as never,
    },
  },
};

describe('frozen host', () => {
  const dir = join(root, 'live');
  const store = new MemoryVersionStore();
  let host: AppHost;
  let id = '';

  beforeAll(async () => {
    host = await AppHost.open(dir, { store });
    await host.execute(
      {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      },
      { author: 't' },
    );
    id = (await host.create('Chore', { title: 'one' })).id as string;
    host.setFrozen(true);
  });
  afterAll(() => host.close());

  it('has a sample for every command type', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      Object.keys(STRUCTURAL_COMMANDS).sort(),
    );
    expect(isStructuralCommand({ type: 'nonsense' })).toBe(true);
  });

  it('refuses plan() and execute() of every structural command, changing nothing', async () => {
    const before = { version: host.version, def: structuredClone(host.def) };
    const versions = (await host.versions()).length;
    for (const [type, structural] of Object.entries(STRUCTURAL_COMMANDS)) {
      if (!structural) continue;
      const cmd = SAMPLES[type as CommandType];
      for (const call of [
        () => host.plan(cmd),
        () => host.execute(cmd, { author: 't', approved: true }),
      ]) {
        const err = await call().then(
          () => null,
          (e) => e,
        );
        expect(err, type).toBeInstanceOf(EngineError);
        expect((err as EngineError).code, type).toBe('refused');
        expect((err as Error).message, type).toMatch(/frozen/);
      }
    }
    expect(host.version).toBe(before.version);
    expect(host.def).toEqual(before.def);
    expect((await host.versions()).length).toBe(versions);
  });

  it('refuses a command of unknown type', async () => {
    await expect(
      host.execute({ type: 'drop' } as never, { author: 't', approved: true }),
    ).rejects.toThrow(/frozen/);
  });

  it('still exports the template, with records', async () => {
    const t = await host.execute(SAMPLES.exportTemplate, { author: 't' });
    expect(
      (t as { records: Record<string, unknown[]> }).records.Chore,
    ).toHaveLength(1);
  });

  it('still serves records through the host, the generated tools and REST', async () => {
    const made = await host.create('Chore', { title: 'two' });
    await host.update('Chore', made.id as string, { title: 'two!' });
    expect((await host.list('Chore')).map((r) => r.title).sort()).toEqual([
      'one',
      'two!',
    ]);
    expect((await host.get('Chore', id)).title).toBe('one');
    const tools = (await host.appTools()).map((t) => t.name);
    expect(tools).toContain('chore_list');
    expect((await host.callAppTool('chore_list')).isError).toBe(false);
    const post = await host.rest({
      method: 'POST',
      url: '/api/chores',
      body: JSON.stringify({ title: 'three' }),
    });
    expect(post.status).toBeLessThan(300);
    expect(
      (await host.rest({ method: 'GET', url: '/api/chores' })).status,
    ).toBe(200);
    // deleting still needs an approval on a frozen (non-draft) host
    await expect(host.remove('Chore', made.id as string)).resolves.toBeTruthy();
    await expect(
      host.callAppTool('chore_delete', { id }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('thaws, and a host can also start frozen', async () => {
    host.setFrozen(false);
    expect(host.frozen).toBe(false);
    await host.execute(SAMPLES.addField, { author: 't' });
    expect(host.def.models.Chore.fields.notes).toBeTruthy();

    const other = join(root, 'starts-frozen');
    const h = await AppHost.open(other, {
      store: new MemoryVersionStore(),
      frozen: true,
    });
    try {
      expect(h.frozen).toBe(true);
      await expect(
        h.execute(SAMPLES.defineModel, { author: 't' }),
      ).rejects.toThrow(/frozen/);
    } finally {
      await h.close();
    }
  });
});

describe('autoApprove', () => {
  it('cannot be enabled on a directory that is not a draft', async () => {
    const dir = join(root, 'plain-live');
    await expect(
      AppHost.open(dir, { store: new MemoryVersionStore(), autoApprove: true }),
    ).rejects.toMatchObject({ code: 'refused' });
  });

  it('cannot be enabled where the marker names the same directory as live', async () => {
    const dir = join(root, 'self-marked');
    mkdirSync(dir, { recursive: true });
    writeDraftMarker(dir, dir, 0);
    await expect(
      AppHost.open(dir, { store: new MemoryVersionStore(), autoApprove: true }),
    ).rejects.toMatchObject({ code: 'refused' });
  });

  it('cannot be enabled with a corrupt marker', async () => {
    const dir = join(root, 'corrupt-marker');
    mkdirSync(dir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, DRAFT_MARKER_FILE), '{nope');
    await expect(
      AppHost.open(dir, { store: new MemoryVersionStore(), autoApprove: true }),
    ).rejects.toMatchObject({ code: 'refused' });
  });

  it('on a draft host approves risky commands, deletes and REST DELETE; there is no setter', async () => {
    const live = join(root, 'ar-live');
    const dir = join(root, 'ar-draft');
    mkdirSync(live, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeDraftMarker(dir, live, 0);
    const draft = await AppHost.open(dir, {
      store: new MemoryVersionStore(),
      autoApprove: true,
    });
    try {
      expect(draft.draft?.baseVersion).toBe(0);
      await draft.execute(
        {
          type: 'defineModel',
          name: 'Chore',
          fields: { title: { type: 'text' }, junk: { type: 'text' } },
        },
        { author: 't' },
      );
      const a = (await draft.create('Chore', { title: 'a' })).id as string;
      const b = (await draft.create('Chore', { title: 'b' })).id as string;
      // risky, no `approved`: runs
      await draft.execute(
        { type: 'removeField', model: 'Chore', field: 'junk' },
        { author: 't' },
      );
      expect(draft.def.models.Chore.fields.junk).toBeUndefined();
      expect((await draft.callAppTool('chore_delete', { id: a })).isError).toBe(
        false,
      );
      const del = await draft.rest({
        method: 'DELETE',
        url: `/api/chores/${b}`,
      });
      expect(del.status).toBeLessThan(300);
      expect(await draft.list('Chore')).toHaveLength(0);

      // nothing on the instance can switch it
      expect('autoApprove' in draft).toBe(false);
      (draft as unknown as { autoApprove: boolean }).autoApprove = false;
    } finally {
      await draft.close();
    }
  });

  it('a host opened without it, even on a draft directory, still asks', async () => {
    const live = join(root, 'na-live');
    const dir = join(root, 'na-draft');
    mkdirSync(live, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeDraftMarker(dir, live, 0);
    const draft = await AppHost.open(dir, { store: new MemoryVersionStore() });
    try {
      await draft.execute(
        { type: 'defineModel', name: 'Chore', fields: { a: { type: 'text' } } },
        { author: 't' },
      );
      await expect(
        draft.execute(
          { type: 'removeField', model: 'Chore', field: 'a' },
          { author: 't' },
        ),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
    } finally {
      await draft.close();
    }
  });

  it('a draft whose base version is missing from its store does not open', async () => {
    const live = join(root, 'mb-live');
    const dir = join(root, 'mb-draft');
    mkdirSync(live, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeDraftMarker(dir, live, 7);
    await expect(
      AppHost.open(dir, { store: new MemoryVersionStore() }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
