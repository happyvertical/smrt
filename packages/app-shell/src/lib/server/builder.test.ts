import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../objects/App.ts';
import { Approval, ApprovalCollection } from '../objects/Approval.ts';
import { AppVersionCollection } from '../objects/AppVersion.ts';
import { listApprovalViews } from './approvals.ts';
import { getHost } from './host.ts';
import { PolicyError } from './owner.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';
import { ShellVersionStore } from './version-store.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);

describe('App builder methods (owner)', () => {
  it('defines a model, adds a field, and stores records through the host', async () => {
    const made = (await asOwner(() =>
      App.defineModel('Chore', { title: { type: 'text' } }),
    )) as { version: number };
    expect(made.version).toBe(1);
    await asOwner(() => App.addField('Chore', 'points', { type: 'text' }));
    const host = await getHost();
    const rec = await host.create('Chore', { title: 'dishes', points: '3' });
    expect(rec.title).toBe('dishes');
    const described = (await asOwner(() => App.describe())) as {
      models: Record<string, { fields: Record<string, unknown> }>;
    };
    expect(Object.keys(described.models.Chore.fields)).toEqual(
      expect.arrayContaining(['title', 'points']),
    );
    const history = (await asOwner(() => App.history())) as {
      version: number;
    }[];
    expect(history.map((v) => v.version)).toEqual([0, 1, 2]);
  });

  it('keeps versions in the shell models (AppVersion, App row)', async () => {
    const versions = await (
      await AppVersionCollection.create({ db: h.db })
    ).list({ limit: 100 });
    expect(versions.length).toBe(3);
    const app = await new ShellVersionStore(h.db).appRow();
    expect(Number(app.currentVersion)).toBe(2);
    expect(JSON.parse(app.definition).models.Chore).toBeTruthy();
  });

  it('accepts JSON strings for object arguments (MCP clients)', async () => {
    const r = (await asOwner(() =>
      App.addField('Chore', 'notes', JSON.stringify({ type: 'text' }) as never),
    )) as { version: number };
    expect(r.version).toBe(3);
  });

  it('rejects malformed arguments', async () => {
    await expect(
      asOwner(() => App.addField('Chore', '', { type: 'text' })),
    ).rejects.toThrow(/non-empty string/);
    await expect(asOwner(() => App.cleanUp(-1))).rejects.toThrow(
      /whole number/,
    );
  });
});

describe('owner-only', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['defineModel', () => App.defineModel('X')],
    ['addField', () => App.addField('Chore', 'z', { type: 'text' })],
    ['hideField', () => App.hideField('Chore', 'notes')],
    ['renameField', () => App.renameField('Chore', 'notes', 'memo')],
    ['removeField', () => App.removeField('Chore', 'notes')],
    [
      'changeFieldType',
      () => App.changeFieldType('Chore', 'points', { type: 'text' }),
    ],
    ['removeModel', () => App.removeModel('Chore')],
    [
      'addMethod',
      () =>
        App.addMethod('Chore', 'm', { description: 'd', code: 'return 1;' }),
    ],
    ['enableRecipe', () => App.enableRecipe('profiles')],
    ['undo', () => App.undo()],
    ['cleanUp', () => App.cleanUp(1)],
    ['exportTemplate', () => App.exportTemplate()],
    ['importTemplate', () => App.importTemplate({ format: 1 })],
    ['describe', () => App.describe()],
    ['history', () => App.history()],
  ];
  it('covers every builder operation', () => {
    expect(calls.map(([n]) => n).sort()).toEqual(
      [
        'defineModel',
        'addField',
        'hideField',
        'renameField',
        'removeField',
        'changeFieldType',
        'removeModel',
        'addMethod',
        'enableRecipe',
        'undo',
        'cleanUp',
        'exportTemplate',
        'importTemplate',
        'describe',
        'history',
      ].sort(),
    );
  });
  for (const [name, call] of calls) {
    it(`${name}: refused for a member, a stranger and no session`, async () => {
      const before = (await (await getHost()).versions()).length;
      for (const who of [h.member, h.stranger]) {
        await expect(runAs(who, call)).rejects.toMatchObject({ status: 403 });
      }
      await expect(call()).rejects.toBeInstanceOf(PolicyError);
      expect((await (await getHost()).versions()).length).toBe(before);
    });
  }
  it('Approval.decide and Approval.pending are owner only', async () => {
    await expect(
      runAs(h.member, () => Approval.pending()),
    ).rejects.toMatchObject({ status: 403 });
    const row = new Approval({ db: h.db } as never);
    await expect(runAs(h.member, () => row.decide(true))).rejects.toMatchObject(
      { status: 403 },
    );
  });
});

describe('approval gating', () => {
  let chore = '';
  beforeAll(async () => {
    const host = await getHost();
    chore = (
      await host.create('Chore', { title: 'gated', points: '1', notes: 'n' })
    ).id as string;
  });

  it('a risky method returns pending_approval and changes nothing', async () => {
    const host = await getHost();
    const before = host.version;
    const out = (await asOwner(() => App.removeField('Chore', 'notes'))) as {
      status: string;
      approvalId: string;
    };
    expect(out.status).toBe('pending_approval');
    expect(host.version).toBe(before);
    expect(host.describe().models.Chore.fields).toHaveProperty('notes');
    const pending = await listApprovalViews({ status: 'pending' });
    expect(pending.map((p) => p.id)).toContain(out.approvalId);
  });

  it('an identical pending command reuses the Approval', async () => {
    const a = (await asOwner(() => App.removeField('Chore', 'notes'))) as {
      approvalId: string;
    };
    const b = (await asOwner(() => App.removeField('Chore', 'notes'))) as {
      approvalId: string;
    };
    expect(a.approvalId).toBe(b.approvalId);
    const rows = (await listApprovalViews({ status: 'pending' })).filter(
      (p) => p.id === a.approvalId,
    );
    expect(rows).toHaveLength(1);
  });

  it('deny records and does not apply', async () => {
    const host = await getHost();
    const out = (await asOwner(() => App.removeField('Chore', 'notes'))) as {
      approvalId: string;
    };
    const row = (await (
      await ApprovalCollection.create({ db: h.db })
    ).get(out.approvalId)) as Approval;
    const res = await runAs(h.owner, () => row.decide(false));
    expect(res.status).toBe('denied');
    expect(host.describe().models.Chore.fields).toHaveProperty('notes');
    const stored = (await listApprovalViews()).find(
      (p) => p.id === out.approvalId,
    );
    expect(stored).toMatchObject({ status: 'denied', decidedBy: h.owner.id });
    // a decided approval cannot be decided again
    await expect(runAs(h.owner, () => row.decide(true))).rejects.toThrow(
      /already/,
    );
    // and a fresh identical request makes a new row
    const again = (await asOwner(() => App.removeField('Chore', 'notes'))) as {
      approvalId: string;
    };
    expect(again.approvalId).not.toBe(out.approvalId);
  });

  it('approve applies the change, attributed to the requester', async () => {
    const host = await getHost();
    const pending = (await listApprovalViews({ status: 'pending' })).find(
      (p) => p.action?.kind === 'command',
    ) as Awaited<ReturnType<typeof listApprovalViews>>[number];
    const row = (await (
      await ApprovalCollection.create({ db: h.db })
    ).get(pending.id)) as Approval;
    const res = await runAs(h.owner, () => row.decide(true));
    expect(res.status).toBe('approved');
    expect(host.describe().models.Chore.fields).not.toHaveProperty('notes');
    const hist = await host.versions();
    expect(hist.at(-1)).toMatchObject({ author: h.owner.id });
  });

  it('a failing approved command is recorded as failed', async () => {
    const out = (await asOwner(() => App.removeField('Chore', 'points'))) as {
      approvalId: string;
    };
    // make it impossible: remove the model first through the host directly
    const host = await getHost();
    await host.execute(
      { type: 'removeField', model: 'Chore', field: 'points' },
      { author: 't', approved: true },
    );
    const row = (await (
      await ApprovalCollection.create({ db: h.db })
    ).get(out.approvalId)) as Approval;
    const res = await runAs(h.owner, () => row.decide(true));
    expect(res.status).toBe('failed');
    expect(res.error).toBeTruthy();
  });

  it('app tools: <model>_delete is gated; engine refuses without approved', async () => {
    const { runAppTool } = await import('./builder.ts');
    const host = await getHost();
    const out = (await runAppTool(
      'chore_delete',
      { id: chore },
      h.owner.id,
      'live',
    )) as { status: string };
    expect(out.status).toBe('pending_approval');
    expect((await host.get('Chore', chore)).id).toBe(chore);
    await expect(
      host.callAppTool('chore_delete', { id: chore }),
    ).rejects.toThrow(/approval required/);
    await expect(
      host.rest({ method: 'DELETE', url: `/api/chores/${chore}` }),
    ).rejects.toThrow(/approval required/);
  });

  it('rest DELETE and record delete become approvals, applied on approve', async () => {
    const { runRest, requestRecordDelete } = await import('./builder.ts');
    const host = await getHost();
    const viaRest = (await runRest(
      { method: 'DELETE', url: `/api/chores/${chore}` },
      h.owner.id,
      'live',
    )) as { status: string; approvalId: string };
    expect(viaRest.status).toBe('pending_approval');
    expect((await host.get('Chore', chore)).id).toBe(chore);
    const viaRecord = (await requestRecordDelete(
      'Chore',
      chore,
      h.owner.id,
      'live',
    )) as { status: string; approvalId: string };
    expect(viaRecord.status).toBe('pending_approval');
    const row = (await (
      await ApprovalCollection.create({ db: h.db })
    ).get(viaRecord.approvalId)) as Approval;
    expect((await runAs(h.owner, () => row.decide(true))).status).toBe(
      'approved',
    );
    await expect(host.get('Chore', chore)).rejects.toThrow();
  });
});

describe('undo that would overwrite newer data', () => {
  it('App.undo and the assistant/MCP door return a pending approval with the count', async () => {
    const host = await getHost();
    await asOwner(() => App.defineModel('Dial', { level: { type: 'text' } }));
    const a = await host.create('Dial', { level: '1' });
    await host.create('Dial', { level: '2' });
    await host.execute(
      {
        type: 'changeFieldType',
        model: 'Dial',
        field: 'level',
        to: { type: 'integer' },
      },
      { author: 't', approved: true },
    );
    await host.update('Dial', a.id as string, { level: 50 });
    const version = host.version;

    const out = (await asOwner(() => App.undo())) as {
      status: string;
      approvalId: string;
      preview: { replaced: number; fields: { model: string; field: string }[] };
    };
    expect(out.status).toBe('pending_approval');
    expect(out.preview.replaced).toBe(1);
    expect(out.preview.fields[0]).toMatchObject({
      model: 'Dial',
      field: 'level',
    });
    expect(host.version).toBe(version);
    // the engine refuses on its own, whatever the caller says
    await expect(
      host.execute({ type: 'undo' }, { author: 'x' }),
    ).rejects.toThrow(/approval required/);
    // an identical request reuses the card
    const again = (await asOwner(() => App.undo())) as { approvalId: string };
    expect(again.approvalId).toBe(out.approvalId);

    const row = (await (
      await ApprovalCollection.create({ db: h.db })
    ).get(out.approvalId)) as Approval;
    expect((await runAs(h.owner, () => row.decide(true))).status).toBe(
      'approved',
    );
    expect(host.version).toBe(version - 1);
    expect((await host.get('Dial', a.id as string)).level).toBe('1');
  });

  it('a plain undo is still immediate', async () => {
    await asOwner(() => App.addField('Dial', 'tag', { type: 'text' }));
    const out = (await asOwner(() => App.undo())) as { status?: string };
    expect(out.status).toBeUndefined();
  });
});

it('requires a fresh approval when merge reference counts grow and performs no writes', async () => {
  const { runCommand } = await import('./builder.ts');
  const host = await getHost();
  await host.execute(
    {
      type: 'defineModel',
      name: 'MergePerson',
      fields: { name: { type: 'text' } },
    },
    { author: 'test' },
  );
  await host.execute(
    {
      type: 'defineModel',
      name: 'MergeInvoice',
      fields: { person: { type: 'reference', ref: 'MergePerson' } },
    },
    { author: 'test' },
  );
  const keep = await host.create('MergePerson', { name: 'Keep' });
  const duplicate = await host.create('MergePerson', { name: 'Duplicate' });
  const pending = (await runCommand(
    {
      type: 'mergeRecords',
      model: 'MergePerson',
      keep: keep.id as string,
      merge: [duplicate.id as string],
    },
    h.owner.id,
    'live',
  )) as { approvalId: string };
  const invoice = await host.create('MergeInvoice', { person: duplicate.id });
  const version = host.version;
  const row = (await (
    await ApprovalCollection.create({ db: h.db })
  ).get(pending.approvalId)) as Approval;
  expect((await runAs(h.owner, () => row.decide(true))).status).toBe('failed');
  expect(host.version).toBe(version);
  expect((await host.get('MergeInvoice', invoice.id as string)).person).toBe(
    duplicate.id,
  );
  expect((await host.get('MergePerson', duplicate.id as string)).name).toBe(
    'Duplicate',
  );
  const fresh = (await listApprovalViews({ status: 'pending' })).find(
    (approval) =>
      approval.action?.kind === 'command' &&
      approval.action.command.type === 'mergeRecords',
  );
  expect(fresh?.id).not.toBe(pending.approvalId);
  expect(fresh?.preview).toMatchObject({
    removed: 1,
    references: { MergeInvoice: 1 },
  });
  if (!fresh) throw new Error('missing fresh approval');
  const next = (await (
    await ApprovalCollection.create({ db: h.db })
  ).get(fresh.id)) as Approval;
  expect((await runAs(h.owner, () => next.decide(true))).status).toBe(
    'approved',
  );
  expect((await host.get('MergeInvoice', invoice.id as string)).person).toBe(
    keep.id,
  );
});

it.each([
  'loadRecords',
  'extractModel',
] as const)('%s reviews larger affected counts again before writing', async (type) => {
  const { runCommand } = await import('./builder.ts');
  const host = await getHost();
  const model = type === 'loadRecords' ? 'ReviewLoad' : 'ReviewExtract';
  await host.execute(
    { type: 'defineModel', name: model, fields: { name: { type: 'text' } } },
    { author: 'test' },
  );
  const first = await host.create(model, { name: 'One' });
  const command =
    type === 'loadRecords'
      ? {
          type,
          model,
          mode: 'upsert' as const,
          key: ['name'],
          rows: [{ name: 'One' }, { name: 'Two' }].map((row) => ({ ...row })),
        }
      : { type, model, field: 'name', into: 'ReviewExtractTarget' };
  // A changed field makes the existing load row an overwrite, hence risky.
  if (type === 'loadRecords') {
    await host.execute(
      { type: 'addField', model, field: 'note', definition: { type: 'text' } },
      { author: 'test' },
    );
    (command as { rows: Record<string, unknown>[] }).rows.forEach((row) => {
      row.note = 'new';
    });
  }
  const pending = (await runCommand(command, h.owner.id, 'live')) as {
    approvalId: string;
  };
  expect(pending.approvalId).toBeTruthy();
  await host.create(model, { name: 'Two' });
  const before = await host.list(model);
  const version = host.version;
  const row = (await (
    await ApprovalCollection.create({ db: h.db })
  ).get(pending.approvalId)) as Approval;
  expect((await runAs(h.owner, () => row.decide(true))).status).toBe('failed');
  expect(host.version).toBe(version);
  expect(await host.list(model)).toEqual(before);
  expect((await host.get(model, first.id as string)).name).toBe('One');
  const fresh = (await listApprovalViews({ status: 'pending' })).find(
    (approval) =>
      approval.action?.kind === 'command' &&
      approval.action.command.type === type,
  );
  expect(fresh?.id).not.toBe(pending.approvalId);
  expect(fresh).toBeDefined();
});
