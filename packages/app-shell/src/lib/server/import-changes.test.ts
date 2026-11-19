// A workbook import's commands are cards of the changes waiting, one per table
// (#5207): grouping, removing one table, the digest-pinned Apply on the batch
// route, and the template that carries its records. Real workers, in-process SQLite.
import { runImport } from '@happyvertical/smrt-spreadsheets/import';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { businessWorkbook } from '../../../test-support/import-workbook.ts';
import { createEngineImportTarget } from '../../engine/import-target.ts';
import * as changesRoute from '../../routes/api/shell/changes/+server.ts';
import * as applyRoute from '../../routes/api/shell/changes/apply/+server.ts';
import { runCommand } from './builder.ts';
import {
  changesState,
  flushChecks,
  recordImportCommand,
  removeChangeCard,
  restoreChangeCard,
} from './changes.ts';
import { startDraft } from './drafts.ts';
import { getDraftSlot, getHost } from './host.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeEach(async () => {
  h = await openShell();
});
afterEach(async () => {
  await h.close();
});
const asOwner = <T>(fn: () => Promise<T>) => runAs(h.owner, fn);
const settle = async () => {
  await asOwner(() => changesState());
  await flushChecks();
  return asOwner(() => changesState());
};

/** What the workflow does: hold a copy, load through the hook, prove, seal, release the hold. */
async function runAnImport() {
  await startDraft('Workbook import', h.owner.id, undefined, 'being checked');
  const slot = (await getDraftSlot())!;
  const host = slot.host!;
  const target = createEngineImportTarget(
    host,
    async () => {},
    async () => {},
    ({ command, run }) =>
      recordImportCommand(h.owner, {
        host,
        group: 'import:one',
        command,
        run,
      }),
  );
  const fixture = businessWorkbook();
  const proof = await runImport({ ...fixture, target });
  expect(proof.ok).toBe(true);
  await target.seal();
  slot.hold = null;
  return host;
}

describe('an import becomes cards grouped by table', () => {
  it('makes one card per table with its load, under one group, rows kept off the view', async () => {
    await runAnImport();
    const state = await settle();
    // Two tables and the plan's report: a card each, in the import's order.
    expect(state.cards.map((c) => c.source)).toEqual([
      'import',
      'import',
      'import',
    ]);
    expect(new Set(state.cards.map((c) => c.group))).toEqual(
      new Set(['import:one']),
    );
    const tables = state.cards.filter(
      (c) => c.commands[0].type === 'defineModel',
    );
    expect(tables.map((c) => c.summary)).toEqual([
      expect.stringMatching(
        /^Customers: new table with \d+ fields and 2 records$/,
      ),
      expect.stringMatching(
        /^Orders: new table with \d+ fields and 2 records$/,
      ),
    ]);
    // Each card holds its table's define, load and hides; rows never reach the browser.
    for (const card of tables) {
      expect(card.commands[0].type).toBe('defineModel');
      expect(card.commands.some((c) => c.type === 'loadRecords')).toBe(true);
      expect(card.commands.at(-1)?.type).toBe('hideField');
      for (const c of card.commands)
        if (c.type === 'loadRecords') expect(c.rows).toEqual([]);
    }
    expect(state.status).toBe('open');
    expect(state.canApply).toBe(true);
  });

  it('refuses a command from anything that does not hold the copy', async () => {
    await startDraft('Not an import', h.owner.id);
    const slot = (await getDraftSlot())!;
    await expect(
      recordImportCommand(h.owner, {
        host: slot.host!,
        group: 'import:x',
        command: { type: 'defineModel', name: 'Sneaky', fields: {} },
        run: async () => {
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow(/holds the copy/);
  });

  it('removes one table and rebuilds; put back replays it, provenance still hidden', async () => {
    await runAnImport();
    const first = await settle();
    const orders = first.cards.find((c) => c.summary.startsWith('Orders'))!;
    const customers = first.cards.find((c) =>
      c.summary.startsWith('Customers'),
    )!;
    const gone = await asOwner(() => removeChangeCard(orders.id));
    expect(gone.count).toBe(2);
    let copy = (await getDraftSlot())!.host!;
    expect(Object.keys(copy.def.models)).toEqual(['Customers']);
    expect(await copy.countRows('Customers')).toBe(2);
    expect(copy.def.models.Customers.fields.workbookLookup.hidden).toBe(true);
    // Orders look Customers up by a field the hide makes invisible: the hides
    // replay after the last load, so putting the table back still works.
    const back = await asOwner(() => restoreChangeCard(orders.id));
    expect(back.count).toBe(3);
    expect(back.cards.every((c) => c.checks.length === 0)).toBe(true);
    copy = (await getDraftSlot())!.host!;
    expect(await copy.countRows('Orders')).toBe(2);
    expect(copy.def.models.Orders.fields.workbookLookup.hidden).toBe(true);
    expect(copy.def.models.Customers.fields.workbookLookup.hidden).toBe(true);
    // Removing the table the others point at flags them instead of failing.
    const flagged = await asOwner(() => removeChangeCard(customers.id));
    const ordersCard = flagged.cards.find((c) => c.id === orders.id)!;
    expect(ordersCard.checks.map((c) => c.code)).toContain(
      'depends_on_removed',
    );
  });

  it('applies through the batch route: a stale digest is a 409, the pinned one applies, old routes are gone', async () => {
    await runAnImport();
    const state = await settle();
    const send = (body: unknown) => {
      const url = new URL('/api/shell/changes/apply', 'http://shell');
      return applyRoute.POST({
        url,
        params: {},
        request: new Request(url, {
          method: 'POST',
          headers: { origin: url.origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        locals: {
          user: { id: h.owner.id },
          tenantId: h.owner.tenantId,
          permissions: [],
        },
      } as never);
    };
    expect((await send({ expect: 'not-the-digest' })).status).toBe(409);
    expect(Object.keys((await getHost()).describe().models)).toEqual([]);
    const ok = await send({ expect: state.digest });
    expect(ok.status).toBe(200);
    const live = await getHost();
    expect(await live.countRows('Orders')).toBe(2);
    expect(await live.countRows('Customers')).toBe(2);
    expect(live.def.models.Orders.fields.workbookLookup.hidden).toBe(true);
    // The GET still answers; the old draft routes do not exist.
    expect(typeof changesRoute.GET).toBe('function');
  });
});

describe('a template with records', () => {
  const template = (records: Record<string, unknown[]>) =>
    ({
      format: 1,
      definition: {
        format: 1,
        name: 'Teams',
        recipes: [],
        models: {
          Team: {
            fields: {
              name: { type: 'text' },
              parent: { type: 'reference', ref: 'Team' },
            },
          },
          Person: {
            fields: {
              name: { type: 'text' },
              team: { type: 'reference', ref: 'Team' },
            },
          },
        },
      },
      records,
    }) as never;

  it('waits as one card and brings its records, links resolved, on Apply', async () => {
    const waiting = await asOwner(() =>
      runCommand(
        {
          type: 'importTemplate',
          data: template({
            // Person first on purpose: the load order follows the links.
            Person: [
              { id: 'p1', name: 'Ada', team: 't2' },
              { id: 'p2', name: 'Lin', team: 't1' },
            ],
            Team: [
              { id: 't1', name: 'Root' },
              { id: 't2', name: 'Child', parent: 't1' },
            ],
          }),
        },
        h.owner.id,
      ),
    );
    expect(waiting).toMatchObject({ status: 'change_waiting' });
    const state = await settle();
    expect(state.count).toBe(1);
    expect(state.cards[0].summary).toBe('Import template: 2 tables, 4 records');
    expect(state.canApply).toBe(true);
    const { applyOwnBatch } = await import('./approvals.ts');
    await asOwner(() => applyOwnBatch(state.digest));
    const live = await getHost();
    const teams = await live.list('Team');
    const root = teams.find((t) => t.name === 'Root')!;
    const child = teams.find((t) => t.name === 'Child')!;
    expect(child.parent).toBe(root.id);
    const people = await live.list('Person');
    expect(people.find((p) => p.name === 'Ada')?.team).toBe(child.id);
    expect(people.find((p) => p.name === 'Lin')?.team).toBe(root.id);
  });
});
