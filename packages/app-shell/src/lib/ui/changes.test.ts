import { describe, expect, it } from 'vitest';
import { card, changes, noChanges } from '../../test/changes-fixtures.ts';
import {
  applyBlock,
  applySummary,
  dependencyActions,
  groupCards,
  isApplySummary,
  isChecking,
  overwriteLines,
  planPill,
  planQuickEdit,
  planReplyBlock,
  quickEditCalls,
} from './changes.ts';
import { announcement, DEPENDS, keysFor, parseShellEvent } from './events.ts';

describe('planPill', () => {
  it('is null when nothing waits', () => {
    expect(planPill(null)).toBeNull();
    expect(planPill(noChanges())).toBeNull();
  });
  it('words one and many, wide and phone', () => {
    const one = planPill(changes({ cards: [card()] }));
    expect(one?.long).toBe('change waiting');
    expect(one?.short).toBe('waiting');
    expect(planPill(changes())?.long).toBe('changes waiting');
    expect(one?.label).toBe('1 change waiting. Review.');
  });
  it('reads checking and blocked states', () => {
    expect(planPill(changes({ checkState: 'stale' }))?.state).toBe('checking');
    const bad = planPill(
      changes({
        checkState: 'blocked',
        blockers: [{ code: 'x', message: 'm' }],
      }),
    );
    expect(bad?.state).toBe('blocked');
    expect(bad?.short).toBe('Needs a look');
    expect(bad?.label).toContain('2 changes waiting');
  });
});

describe('quick edit', () => {
  it('offers name and choices for a choice field, never a default', () => {
    const plan = planQuickEdit(card());
    expect(plan).toEqual({
      label: 'Fulfillment',
      labelName: 'Name',
      fields: [{ name: 'Choices', choices: ['Pickup', 'Delivery'] }],
    });
    expect(
      quickEditCalls(plan!, {
        label: 'Delivery method',
        choices: [['Pickup', 'Delivery', 'Courier']],
      }),
    ).toEqual([
      { label: 'Delivery method' },
      { choices: ['Pickup', 'Delivery', 'Courier'] },
    ]);
    expect(
      quickEditCalls(plan!, {
        label: 'Fulfillment',
        choices: [['Pickup', 'Delivery']],
      }),
    ).toEqual([]);
  });
  it('names the field for a new table and skips what the server refuses', () => {
    const table = card({
      commands: [
        {
          type: 'defineModel',
          name: 'Order',
          label: 'Orders',
          fields: {
            status: { type: 'choice', label: 'Status', choices: ['New'] },
          },
        },
      ],
    });
    const plan = planQuickEdit(table)!;
    expect(
      quickEditCalls(plan, { label: 'Orders', choices: [['New', 'Done']] }),
    ).toEqual([{ field: 'status', choices: ['New', 'Done'] }]);
    expect(planQuickEdit(card({ opaque: true }))).toBeNull();
    expect(planQuickEdit(card({ commands: [] }))).toBeNull();
    expect(
      planQuickEdit(card({ commands: [{ type: 'removeField' }] })),
    ).toBeNull();
  });
});

describe('checks and dependent cards', () => {
  it('treats stale and checking alike, and blockers win over checking', () => {
    expect(isChecking(changes({ checkState: 'checking' }))).toBe(true);
    expect(isChecking(changes({ checkState: 'ok' }))).toBe(false);
    expect(
      applyBlock(changes({ checkState: 'checking', canApply: false })),
    ).toMatch(/Checking/);
    expect(
      planPill(changes({ checkState: 'checking', canApply: false }))?.state,
    ).toBe('checking');
    expect(
      applyBlock(
        changes({
          checkState: 'checking',
          blockers: [{ code: 'x', message: 'm' }],
        }),
      ),
    ).toBe("Can't apply yet");
  });

  it('offers Put it back only when the removed change is known', () => {
    const flagged = card({
      checks: [{ code: 'depends_on_removed', message: 'm', cause: 'c0' }],
    });
    expect(dependencyActions(flagged)).toEqual({ putBack: 'c0' });
    expect(
      dependencyActions(
        card({ checks: [{ code: 'depends_on_removed', message: 'm' }] }),
      ),
    ).toEqual({ putBack: null });
    expect(dependencyActions(card())).toBeNull();
    expect(dependencyActions({ ...flagged, status: 'removed' })).toBeNull();
  });
});

describe('apply and events', () => {
  it('says why Apply is off', () => {
    expect(applyBlock(changes())).toBeNull();
    expect(
      applyBlock(changes({ checkState: 'stale', canApply: false })),
    ).toMatch(/Checking/);
    expect(
      applyBlock(
        changes({ blockers: [{ code: 'x', message: 'm' }], canApply: false }),
      ),
    ).toBe("Can't apply yet");
  });
  it('shows overwrites only as a count line', () => {
    expect(overwriteLines(changes())[0]).toBe(
      'No existing records are replaced',
    );
    expect(
      overwriteLines(
        changes({
          overwrites: {
            recordsUpdated: 2,
            recordsMerged: 1,
            archivedValues: 4,
            archivedTables: 0,
          },
        }),
      ),
    ).toEqual([
      '3 existing records replaced',
      '4 values kept aside so Undo can bring them back',
    ]);
  });
  it('parses the changes event, reloads the count, and says Applied once', () => {
    const e = parseShellEvent(
      '{"type":"changes","status":"applied","batchId":"b","count":0,"generation":4}',
    );
    expect(e).toMatchObject({ type: 'changes', status: 'applied' });
    expect(keysFor(e!)).toContain(DEPENDS.changes);
    expect(keysFor(e!)).toContain(DEPENDS.records);
    expect(
      keysFor(
        parseShellEvent('{"type":"changes","status":"changed","count":2}')!,
      ),
    ).toEqual([DEPENDS.changes, DEPENDS.history]);
    expect(announcement(e!)).toBe('Applied. Your app is live.');
    expect(
      announcement({
        type: 'approval',
        id: 'a',
        status: 'approved',
        summary: applySummary(3),
      }),
    ).toBeNull();
    expect(isApplySummary('Apply 1 waiting change')).toBe(true);
    expect(
      announcement({ type: 'draft', status: 'started', id: 'd', name: 'x' }),
    ).toBeNull();
  });
});

describe('groupCards', () => {
  const c = (id: string, group = '') =>
    card({ id, group, position: Number(id.slice(1)) });
  it('keeps ordinary cards alone and folds a run of one group into one row', () => {
    const rows = groupCards([
      c('c0'),
      c('c1', 'import:x'),
      c('c2', 'import:x'),
      c('c3'),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['card', 'group', 'card']);
    const group = rows[1];
    expect(group.kind === 'group' && group.cards.map((x) => x.id)).toEqual([
      'c1',
      'c2',
    ]);
    expect(group.kind === 'group' && group.title).toBe(
      'Imported from your workbook',
    );
  });
});

describe('planReplyBlock (#5395)', () => {
  const asked = card({
    questions: [{ id: 'q', text: 'Keep it here?', choices: [], state: 'open' }],
  });
  it('carries the open questions and leads with Review, even for a small addition', () => {
    const block = planReplyBlock(changes({ cards: [asked], applyNow: true }));
    expect(block).toMatchObject({
      questions: 1,
      questionTexts: ['Keep it here?'],
      lead: 'review',
      applyNow: false,
    });
  });
  it("reads the items in the steps line's plain words, present tense (#5608)", () => {
    const summaries = [
      'Enable recipe: Profiles',
      'Add model: Orders',
      'Add field: Priority in Orders',
    ];
    const block = planReplyBlock(
      changes({ cards: summaries.map((summary) => card({ summary })) }),
    );
    expect(block?.lines).toEqual([
      'Set up profiles',
      'Add orders',
      'Add a Priority field to orders',
    ]);
  });
  it('offers Apply now for a small addition with nothing to answer', () => {
    expect(
      planReplyBlock(changes({ cards: [card()], applyNow: true })),
    ).toMatchObject({ applyNow: true, questionTexts: [] });
  });
});
