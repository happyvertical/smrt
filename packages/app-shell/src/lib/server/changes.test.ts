// Changes waiting (#5178, slice #5203): structural commands become cards and
// reach live only through the owner's Apply; remove / put back / quick edit /
// discard / undo; adoption of an open draft. In-process SQLite, real workers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Command } from '../../engine/index.ts';
import { STRUCTURAL_COMMANDS } from '../../engine/index.ts';
import { App } from '../objects/App.ts';
import { ApprovalCollection } from '../objects/Approval.ts';
import { applyOwnBatch } from './approvals.ts';
import { runCommand } from './builder.ts';
import {
  addChangeCard,
  changesState,
  discardChanges,
  editChangeCard,
  previewChanges,
  removeChangeCard,
  restoreChangeCard,
  restoreDiscardedChanges,
  undoOwnBatch,
  waitingCount,
} from './changes.ts';
import { startDraft } from './drafts.ts';
import { getHost } from './host.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);
const state = () => asOwner(() => changesState());

/** Structure straight onto live, the way the engine tests set an app up (no card). */
async function liveDo(command: Command) {
  await (await getHost()).execute(command, {
    author: h.owner.id,
    approved: true,
  });
}

beforeAll(async () => {
  h = await openShell();
  await liveDo({
    type: 'defineModel',
    name: 'Chore',
    fields: { title: { type: 'text' } },
  });
  await (await getHost()).create('Chore', { title: 'live-1' });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  if ((await state()).batchId) await asOwner(() => discardChanges());
});

const addField = (field: string, extra: object = {}) =>
  runCommand(
    {
      type: 'addField',
      model: 'Chore',
      field,
      definition: { type: 'text', ...extra },
    },
    h.owner.id,
    'live',
    'assistant',
  );

describe('interception', () => {
  it('no structural command reaches live; each becomes a card', async () => {
    const live = await getHost();
    const version = live.version;
    const def = JSON.stringify(live.def);
    for (const [type, structural] of Object.entries(STRUCTURAL_COMMANDS)) {
      if (!structural || ['undo', 'undoTo', 'cleanUp'].includes(type)) continue;
      // arguments are placeholders: most are refused by the working copy, and
      // none may ever land on live
      await asOwner(() =>
        runCommand(
          {
            type,
            model: 'Chore',
            field: 'x',
            name: 'Zed',
            from: 'a',
            to: 'b',
          } as never,
          h.owner.id,
          'live',
          'api',
        ),
      ).catch(() => {});
      expect(live.version).toBe(version);
    }
    expect(JSON.stringify(live.def)).toBe(def);
  });

  it('a field added through the builder waits as one card; live is unchanged and frozen', async () => {
    const out = await asOwner(() => addField('phone'));
    expect(out).toMatchObject({
      status: 'change_waiting',
      waiting: true,
      count: 1,
    });
    const live = await getHost();
    expect(live.def.models.Chore.fields.phone).toBeUndefined();
    expect(live.frozen).toBe(true);
    const s = await state();
    expect(s.count).toBe(1);
    expect(s.cards[0]).toMatchObject({
      source: 'assistant',
      status: 'active',
      revision: 1,
    });
    expect(s.canApply).toBe(true);
    // records keep working on live
    await live.create('Chore', { title: 'live-2' });
    expect(await live.countRows('Chore')).toBe(2);
    await live.remove('Chore', (await live.list('Chore'))[1].id as string);
  });

  it('a second card builds on the first (planned and run on the working copy)', async () => {
    await asOwner(() =>
      runCommand(
        { type: 'defineModel', name: 'Gadget', fields: {} },
        h.owner.id,
        'live',
        'api',
      ),
    );
    await asOwner(() =>
      runCommand(
        {
          type: 'addField',
          model: 'Gadget',
          field: 'size',
          definition: { type: 'integer' },
        },
        h.owner.id,
        'live',
        'api',
      ),
    );
    expect((await state()).count).toBe(2);
  });

  it("undo and clean up are the owner's from History: refused for others, and while changes wait", async () => {
    await expect(
      asOwner(() =>
        runCommand({ type: 'undo' }, h.owner.id, 'live', 'assistant'),
      ),
    ).rejects.toThrow(/owner from History/);
    await asOwner(() => addField('a'));
    await expect(
      asOwner(() => runCommand({ type: 'undo' }, h.owner.id, 'live', 'owner')),
    ).rejects.toThrow(/Apply or discard your 1 waiting change first/);
    expect(await asOwner(() => waitingCount())).toBe(1);
  });

  it('only the owner can add or read changes', async () => {
    await expect(runAs(h.member, () => changesState())).rejects.toThrow();
    await expect(
      runAs(h.member, () => App.defineModel('X', {})),
    ).rejects.toThrow();
  });
});

describe('remove, put back, quick edit', () => {
  it('removes a card (rebuild), blocks a dependent one, puts it back', async () => {
    await asOwner(() =>
      runCommand(
        { type: 'defineModel', name: 'Gadget', fields: {} },
        h.owner.id,
        'live',
        'api',
      ),
    );
    await asOwner(() =>
      runCommand(
        {
          type: 'addField',
          model: 'Gadget',
          field: 'size',
          definition: { type: 'integer' },
        },
        h.owner.id,
        'live',
        'api',
      ),
    );
    const [first, second] = (await state()).cards;
    let s = await asOwner(() => removeChangeCard(first.id));
    expect(s.count).toBe(1);
    expect(s.cards.find((c) => c.id === second.id)?.checks[0]?.code).toBe(
      'depends_on_removed',
    );
    expect(s.canApply).toBe(false);
    await expect(
      asOwner(() => applyOwnBatch(s.digest || 'x')),
    ).rejects.toThrow();
    s = await asOwner(() => restoreChangeCard(first.id));
    expect(s.count).toBe(2);
    expect(s.cards.every((c) => c.checks.length === 0)).toBe(true);
    expect(s.canApply).toBe(true);
    // removing the last waiting change thaws live
    for (const c of s.cards) s = await asOwner(() => removeChangeCard(c.id));
    expect(s.count).toBe(0);
    expect((await getHost()).frozen).toBe(false);
  });

  it('quick edit patches the label, bumps the revision, and refuses other fields', async () => {
    await asOwner(() =>
      addField('stage', { type: 'choice', choices: ['a', 'b'] }),
    );
    const [card] = (await state()).cards;
    const s = await asOwner(() =>
      editChangeCard(card.id, {
        label: 'Pipeline stage',
        choices: ['x', 'y', 'z'],
      }),
    );
    const edited = s.cards[0];
    expect(edited.revision).toBe(2);
    expect(edited.commands[0]).toMatchObject({
      definition: { label: 'Pipeline stage', choices: ['x', 'y', 'z'] },
    });
    expect(s.digest).not.toBe('');
    await expect(
      asOwner(() => editChangeCard(card.id, { default: 'x' })),
    ).rejects.toThrow(/default/);
    await expect(
      asOwner(() => editChangeCard(card.id, { label: '' })),
    ).rejects.toThrow();
  });

  it('a stale generation is refused (two open windows)', async () => {
    await asOwner(() => addField('g'));
    const s = await state();
    await expect(
      asOwner(() =>
        removeChangeCard(s.cards[0].id, { generation: s.generation - 1 }),
      ),
    ).rejects.toThrow(/another window/);
  });
});

describe('apply and undo', () => {
  it('Apply is digest-pinned, records an apply-batch approval, and lands on live', async () => {
    await asOwner(() => addField('email'));
    const s = await state();
    await expect(asOwner(() => applyOwnBatch(undefined))).rejects.toThrow(
      /expect/,
    );
    await expect(
      asOwner(() => applyOwnBatch('stale-digest')),
    ).rejects.toMatchObject({
      code: 'refused',
    });
    const live = await getHost();
    expect(live.def.models.Chore.fields.email).toBeUndefined();
    const out = await asOwner(() => applyOwnBatch(s.digest));
    expect(out.status).toBe('approved');
    expect(live.def.models.Chore.fields.email).toBeDefined();
    expect(live.frozen).toBe(false);
    const after = await state();
    expect(after.count).toBe(0);
    expect(after.lastApplied?.versions.length).toBe(1);
    const approvals = await (
      await ApprovalCollection.create({ db: h.db })
    ).list({});
    expect(
      approvals.some(
        (a) => /apply-batch/.test(a.command) && a.status === 'approved',
      ),
    ).toBe(true);
  });

  it('an edit after review makes the reviewed digest refused (409)', async () => {
    await asOwner(() => addField('city'));
    const reviewed = await state();
    await asOwner(() => addField('zip'));
    await expect(
      asOwner(() => applyOwnBatch(reviewed.digest)),
    ).rejects.toMatchObject({
      code: 'refused',
    });
    expect((await getHost()).def.models.Chore.fields.city).toBeUndefined();
  });

  it('Undo takes the batch back, keeps records added since, and is digest-pinned', async () => {
    await asOwner(() => addField('nickname'));
    const s = await state();
    await asOwner(() => applyOwnBatch(s.digest));
    const live = await getHost();
    await live.create('Chore', { title: 'after-apply', nickname: 'nick' });
    const applied = (await state()).lastApplied;
    expect(applied).toBeTruthy();
    await expect(
      asOwner(() => undoOwnBatch(applied?.batchId, 'wrong')),
    ).rejects.toMatchObject({ code: 'refused' });
    await asOwner(() => undoOwnBatch(applied?.batchId, applied?.undoDigest));
    expect(live.def.models.Chore.fields.nickname).toBeUndefined();
    expect(
      (await live.list('Chore')).some((r) => r.title === 'after-apply'),
    ).toBe(true);
    await expect(
      asOwner(() => undoOwnBatch(applied?.batchId, applied?.undoDigest)),
    ).rejects.toThrow();
  });

  it('Undo waits while changes wait', async () => {
    await asOwner(() => addField('u1'));
    let s = await state();
    await asOwner(() => applyOwnBatch(s.digest));
    const applied = (await state()).lastApplied;
    await asOwner(() => addField('u2'));
    await expect(
      asOwner(() => undoOwnBatch(applied?.batchId, applied?.undoDigest)),
    ).rejects.toThrow(/Apply or discard your 1 waiting change first/);
    s = await state();
    expect(s.count).toBe(1);
  });

  it('the preview shows what Apply would do', async () => {
    await asOwner(() => addField('pv'));
    const out = await asOwner(() => previewChanges());
    expect(out.preview.digest).toBeTruthy();
    expect(out.changes.count).toBe(1);
  });
});

describe('discard and put back', () => {
  it('discard thaws live and keeps the cards; Put them back restores them', async () => {
    await asOwner(() => addField('d1'));
    await asOwner(() => addField('d2'));
    let s = await asOwner(() => discardChanges());
    expect(s.count).toBe(0);
    expect(s.discarded?.count).toBe(2);
    expect((await getHost()).frozen).toBe(false);
    s = await asOwner(() => restoreDiscardedChanges());
    expect(s.count).toBe(2);
    expect((await getHost()).frozen).toBe(true);
    expect(s.canApply).toBe(true);
  });
});

describe('adopting an open draft', () => {
  it('an existing draft becomes opaque, non-removable cards, and can be applied', async () => {
    await startDraft('Old draft', h.owner.id);
    const slotHost = (await import('./host.ts')).getDraftSlot;
    const draft = (await slotHost())?.host;
    await draft?.execute(
      {
        type: 'addField',
        model: 'Chore',
        field: 'legacy',
        definition: { type: 'text' },
      },
      { author: h.owner.id },
    );
    const s = await state();
    expect(s.count).toBe(1);
    expect(s.cards[0]).toMatchObject({
      opaque: true,
      editable: false,
      commands: [],
    });
    await expect(
      asOwner(() => removeChangeCard(s.cards[0].id)),
    ).rejects.toThrow(/cannot be removed/);
    // a new change appends after the adopted ones, incrementally
    await asOwner(() => addField('modern'));
    expect((await state()).count).toBe(2);
    const fresh = await state();
    await expect(
      asOwner(() => removeChangeCard(fresh.cards[1].id)),
    ).rejects.toThrow(/started before changes waiting/);
    await asOwner(() => applyOwnBatch(fresh.digest));
    const live = await getHost();
    expect(live.def.models.Chore.fields.legacy).toBeDefined();
    expect(live.def.models.Chore.fields.modern).toBeDefined();
  });
});

describe('addChangeCard', () => {
  it('refuses a command that does not apply and makes no card', async () => {
    await expect(
      asOwner(() =>
        addChangeCard({
          source: 'api',
          commands: [
            {
              type: 'addField',
              model: 'Nope',
              field: 'x',
              definition: { type: 'text' },
            },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect((await state()).count).toBe(0);
    expect((await getHost()).frozen).toBe(false);
  });
});
