import { describe, expect, it } from 'vitest';
import { describeApproval, failureText, splitApprovals } from './approvals.ts';
import type { ApprovalView } from './types.ts';

const view = (over: Partial<ApprovalView>): ApprovalView => ({
  id: 'a',
  status: 'pending',
  summary: 's',
  preview: {},
  action: null,
  requestedBy: 'u',
  decidedBy: '',
  decidedAt: '',
  result: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('approval descriptions', () => {
  it('counts archived values for a removed field', () => {
    const d = describeApproval(
      view({
        action: { kind: 'command', command: { type: 'removeField' } },
        preview: { model: 'Chore', field: 'notes', valuesArchived: 1 },
      }),
    );
    expect(d.lines.join(' ')).toContain('Chore.notes');
    expect(d.lines.join(' ')).toContain('1 stored value will be archived');
    expect(d.destructive).toBe(false);
  });

  it('warns about values that will not convert', () => {
    const d = describeApproval(
      view({
        action: { kind: 'command', command: { type: 'changeFieldType' } },
        preview: {
          model: 'M',
          field: 'f',
          from: 'text',
          to: 'integer',
          withValue: 5,
          convertible: 3,
          failingCount: 2,
        },
      }),
    );
    expect(d.lines.join(' ')).toContain('2 values cannot convert');
  });

  it('carries the code of a new method', () => {
    const d = describeApproval(
      view({
        action: { kind: 'command', command: { type: 'addMethod' } },
        preview: {
          model: 'Chore',
          method: 'complete',
          description: 'Marks done',
          code: 'return 1;',
        },
      }),
    );
    expect(d.blocks).toEqual([
      { title: 'Chore.complete()', code: 'return 1;' },
    ]);
  });

  it('shows every method of an imported template in full', () => {
    const d = describeApproval(
      view({
        action: { kind: 'command', command: { type: 'importTemplate' } },
        preview: {
          models: ['Chore', 'Errand'],
          records: 0,
          methods: [
            {
              model: 'Chore',
              name: 'done',
              description: 'Marks done',
              params: {},
              code: 'return 1;',
            },
            {
              model: 'Errand',
              name: 'wipe',
              description: '',
              params: {},
              code: 'return 2;',
            },
          ],
        },
      }),
    );
    expect(d.lines.join(' ')).toContain('2 code methods');
    expect(d.blocks.map((b) => b.code)).toEqual(['return 1;', 'return 2;']);
    expect(d.blocks[0].title).toContain('Chore.done()');
  });

  it('describes an undo that overwrites newer values', () => {
    const d = describeApproval(
      view({
        action: { kind: 'command', command: { type: 'undo', version: 3 } },
        preview: {
          version: 3,
          fields: [{ model: 'Chore', field: 'points', rows: 2 }],
          replaced: 2,
        },
      }),
    );
    expect(d.lines.join(' ')).toContain('Chore.points');
    expect(d.lines.join(' ')).toContain('2 records changed since');
    expect(d.destructive).toBe(true);
  });

  it('flags cleanUp and deletes as permanent', () => {
    const clean = describeApproval(
      view({
        action: { kind: 'command', command: { type: 'cleanUp' } },
        preview: { versions: [1, 2], archivedValues: 7, archivedTables: 1 },
      }),
    );
    expect(clean.destructive).toBe(true);
    expect(clean.lines.join(' ')).toContain('2 older changes');
    expect(
      describeApproval(
        view({ action: { kind: 'record-delete', model: 'Chore', id: 'x' } }),
      ).destructive,
    ).toBe(true);
  });

  it('handles a missing action and splits by status', () => {
    expect(describeApproval(view({})).lines).toEqual([]);
    const s = splitApprovals([view({}), view({ status: 'denied' })]);
    expect(s.pending).toHaveLength(1);
    expect(s.decided).toHaveLength(1);
  });

  it('reads a failure message from the result', () => {
    expect(
      failureText(view({ status: 'failed', result: { error: 'boom' } })),
    ).toBe('boom');
    expect(failureText(view({ status: 'approved' }))).toBeNull();
  });
});

for (const [type, preview, expected] of [
  [
    'mergeRecords',
    {
      modelLabel: 'Customers',
      keepLabel: 'Acme',
      removed: 2,
      references: { Order: 3 },
      referenceLabels: { Order: 'Orders' },
    },
    ['2 Customers records', 'Acme', '3 references in Orders'],
  ],
  [
    'extractModel',
    {
      modelLabel: 'Orders',
      fieldLabel: 'Customer name',
      intoLabel: 'Customers',
      rows: 4,
      create: 2,
      matched: 1,
      distinct: 3,
      folded: 1,
    },
    [
      'Customer name',
      '4 records',
      '2 linked records created',
      '1 existing records matched',
    ],
  ],
  [
    'loadRecords',
    { modelLabel: 'Orders', insert: 1, update: 2, unchanged: 3, rejected: 0 },
    [
      'Orders',
      '1 inserted, 2 updated, 3 unchanged, 0 rejected',
      'overwrite stored values',
    ],
  ],
  [
    'setCalculation',
    { modelLabel: 'Orders', fieldLabel: 'Invoice total', rows: 4 },
    ['Invoice total', '4 records', 'replaces ordinary stored values'],
  ],
] as const) {
  it(`explains ${type} using reviewed counts and human labels`, () => {
    const description = describeApproval(
      view({ action: { kind: 'command', command: { type } }, preview }),
    );
    for (const text of expected)
      expect(description.lines.join(' ')).toContain(text);
    expect(description.lines.join(' ')).toContain('Undo restores');
  });
}
