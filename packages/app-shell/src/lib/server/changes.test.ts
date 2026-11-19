// Changes waiting (#5178, slice #5203): structural commands become cards and
// reach live only through the owner's Apply; remove / put back / quick edit /
// discard / undo; adoption of an open draft. In-process SQLite, real workers.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { Command } from '../../engine/index.ts';
import { STRUCTURAL_COMMANDS } from '../../engine/index.ts';
import { App } from '../objects/App.ts';
import { ApprovalCollection } from '../objects/Approval.ts';
import { applyOwnBatch } from './approvals.ts';
import { runCommand } from './builder.ts';
import {
  type AfterChecksInfo,
  addChangeCard,
  changesState,
  configureChecks,
  discardChanges,
  editChangeCard,
  flushChecks,
  previewChanges,
  removeChangeCard,
  removeDependentCards,
  restoreChangeCard,
  restoreDiscardedChanges,
  runChecksFor,
  setAfterChecks,
  undoOwnBatch,
  waitingCount,
} from './changes.ts';
import { startDraft } from './drafts.ts';
import { subscribe } from './events.ts';
import { getHost } from './host.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);
/** The state after the debounced exact checks have run. */
const state = async () => {
  await asOwner(() => changesState());
  await flushChecks();
  return asOwner(() => changesState());
};

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
  await liveDo({
    type: 'defineModel',
    name: 'Pet',
    fields: { name: { type: 'text' }, age: { type: 'integer' } },
  });
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
    expect((await state()).canApply).toBe(true);
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
    expect(s.canApply).toBe(false); // checking again
    expect((await state()).canApply).toBe(true);
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

// ---------- the checks pipeline, Can't apply yet, digest-pinned Apply (#5205) ----------

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      setTimeout(fn: () => void, ms: number) {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(h: unknown) {
        timers.delete(h as number);
      },
    },
    tick(ms: number) {
      now += ms;
      for (const [id, t] of [...timers])
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
    },
  };
}

const gadgetCards = async () => {
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
  await asOwner(() => addField('indep'));
  return (await state()).cards;
};

describe('checks pipeline', () => {
  afterEach(() => configureChecks({}));

  it('runs a debounced exact check after a mutation and announces it', async () => {
    const f = fakeClock();
    configureChecks({ clock: f.clock, delayMs: 2000 });
    const seen: string[] = [];
    const off = subscribe((e) => {
      if (e.type === 'changes') seen.push(e.status);
    });
    await asOwner(() => addField('p1'));
    let s = await asOwner(() => changesState());
    expect(s.checkState).toBe('stale');
    expect(s.canApply).toBe(false);
    expect(s.digest).toBe('');
    seen.length = 0;
    f.tick(1999);
    expect((await asOwner(() => changesState())).checkState).toBe('stale');
    f.tick(1); // the debounce elapsed: the job is queued, flush waits for it
    await flushChecks();
    s = await asOwner(() => changesState());
    expect(s.checkState).toBe('ok');
    expect(s.digest).not.toBe('');
    expect(s.canApply).toBe(true);
    expect(seen).toContain('changed');
    off();
  });

  it('a result from an older generation is discarded', async () => {
    const f = fakeClock();
    configureChecks({ clock: f.clock, delayMs: 2000 });
    await asOwner(() => addField('g1'));
    const old = await asOwner(() => changesState());
    await asOwner(() => addField('g2')); // generation moves on
    await runChecksFor(old.batchId as string, old.generation);
    const s = await asOwner(() => changesState());
    expect(s.generation).toBeGreaterThan(old.generation);
    expect(s.checkState).toBe('stale');
    expect(s.digest).toBe('');
    await flushChecks();
    expect((await asOwner(() => changesState())).checkState).toBe('ok');
  });

  it('runs outside the owner scope and hands slice 5 a data-only hook', async () => {
    const f = fakeClock();
    configureChecks({ clock: f.clock, delayMs: 10 });
    const calls: AfterChecksInfo[] = [];
    let current: boolean[] = [];
    setAfterChecks(async (info) => {
      calls.push(info);
      throw new Error('a review that fails must not break checks');
    });
    try {
      await asOwner(() => addField('hook1'));
      await flushChecks(); // no runAs here: the job carries its own owner
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ ok: true });
      current = [await calls[0].isCurrent()];
      await asOwner(() => addField('hook2'));
      current.push(await calls[0].isCurrent());
      expect(current).toEqual([true, false]);
      expect(Object.keys(calls[0]).sort()).toEqual(
        ['batchId', 'generation', 'isCurrent', 'ok', 'owner'].sort(),
      );
    } finally {
      setAfterChecks(null);
    }
  });
});

describe("Can't apply yet and dependent cards", () => {
  it('a removed card flags the ones after it; Apply is refused with the blockers however the client behaves', async () => {
    const [first, second, indep] = await gadgetCards();
    const reviewed = await state(); // a digest the client may still hold
    let s = await asOwner(() => removeChangeCard(first.id));
    s = await state(); // exact checks have run since
    const flagged = s.cards.find((c) => c.id === second.id);
    expect(flagged?.checks[0]).toMatchObject({
      code: 'depends_on_removed',
      cause: first.id,
    });
    expect(s.cards.find((c) => c.id === indep.id)?.checks).toEqual([]);
    expect(s.canApply).toBe(false);
    expect(s.checkState).toBe('blocked');
    expect(s.blockers.every((b) => !/draft|publish/i.test(b.message))).toBe(
      true,
    );
    for (const expectDigest of [reviewed.digest, s.digest, 'whatever']) {
      const err = await asOwner(() => applyOwnBatch(expectDigest)).catch(
        (e) => e,
      );
      expect(err).toMatchObject({
        code: 'refused',
        details: { reason: 'blocked' },
      });
      expect(
        (err.details.blockers as { cardId: string }[]).map((b) => b.cardId),
      ).toContain(second.id);
    }
    expect((await getHost()).def.models.Chore.fields.indep).toBeUndefined();
  });

  it('"Put it back" restores the removed change and clears the flag', async () => {
    const [first, second] = await gadgetCards();
    await asOwner(() => removeChangeCard(first.id));
    let s = await state();
    const cause = s.cards.find((c) => c.id === second.id)?.checks[0]?.cause;
    expect(cause).toBe(first.id);
    s = await asOwner(() => restoreChangeCard(cause as string));
    s = await state();
    expect(s.cards.every((c) => c.checks.length === 0)).toBe(true);
    expect(s.canApply).toBe(true);
  });

  it('"Remove those too" removes every change that needs the removed one and nothing else', async () => {
    const [first, second, indep] = await gadgetCards();
    await asOwner(() => removeChangeCard(first.id));
    let s = await asOwner(() => removeDependentCards(second.id));
    expect(s.count).toBe(1);
    expect(s.cards.find((c) => c.id === indep.id)?.status).toBe('active');
    expect(s.cards.find((c) => c.id === second.id)?.status).toBe('removed');
    s = await state();
    expect(s.canApply).toBe(true);
    // a change that is not waiting on a removed one is refused
    await expect(
      asOwner(() => removeDependentCards(indep.id)),
    ).rejects.toMatchObject({ code: 'refused' });
    await expect(
      asOwner(() => removeDependentCards('missing')),
    ).rejects.toThrow();
    // and it is the owner's alone
    await expect(
      runAs(h.member, () => removeDependentCards(second.id)),
    ).rejects.toThrow();
  });
});

describe('overwrites are shown and pinned, never blocking', () => {
  const load = (rows: { name: string; age: number }[]): Command => ({
    type: 'loadRecords',
    model: 'Pet',
    mode: 'upsert',
    key: ['name'],
    rows,
  });
  const addLoad = (rows: { name: string; age: number }[]) =>
    runCommand(load(rows), h.owner.id, 'live', 'api');

  it('a load that overwrites rows shows the count and still applies', async () => {
    const live = await getHost();
    await live.create('Pet', { name: 'ow-a', age: 1 });
    await asOwner(() =>
      addLoad([
        { name: 'ow-a', age: 2 },
        { name: 'ow-new', age: 3 },
      ]),
    );
    const s = await state();
    expect(s.overwrites?.recordsUpdated).toBe(1);
    expect(s.checkState).toBe('ok');
    expect(s.canApply).toBe(true);
    await asOwner(() => applyOwnBatch(s.digest));
    expect((await live.list('Pet')).map((r) => r.name)).toContain('ow-new');
  });

  it('records added to live meanwhile that overwrite nothing do not change the digest', async () => {
    const live = await getHost();
    await asOwner(() => addLoad([{ name: 'pin-1', age: 1 }]));
    const reviewed = await state();
    await live.create('Pet', { name: 'unrelated-while-waiting', age: 9 });
    const out = await asOwner(() => applyOwnBatch(reviewed.digest));
    expect(out.status).toBe('approved');
  });

  it('a record that turns an insert into an update asks for a fresh look (409), then applies', async () => {
    const live = await getHost();
    await asOwner(() => addLoad([{ name: 'pin-2', age: 1 }]));
    const reviewed = await state();
    expect(reviewed.overwrites?.recordsUpdated).toBe(0);
    await live.create('Pet', { name: 'pin-2', age: 5 });
    await expect(
      asOwner(() => applyOwnBatch(reviewed.digest)),
    ).rejects.toMatchObject({
      code: 'refused',
      details: { reason: 'changed' },
    });
    // the new count is shown on the next check and, once seen, applies
    await asOwner(() => changesState());
    const again = await (async () => {
      await asOwner(() => addField('bumpRecheck'));
      return state();
    })();
    expect(again.overwrites?.recordsUpdated).toBe(1);
    expect(again.canApply).toBe(true);
    await asOwner(() => applyOwnBatch(again.digest));
  });
});
