import { describe, expect, it } from 'vitest';
import {
  preview,
  publishApproval,
  versions,
} from '../../test/draft-fixtures.ts';
import { describeApproval } from './approvals.ts';
import { groupHistory, publishCalculations, publishLines } from './publish.ts';

describe('publish preview', () => {
  it('includes definitions, intermediate conversions, archive counts, and every method in approvals', () => {
    const lines = publishLines(preview).join('\n');
    expect(lines).toContain('Models added: 1. Fields added: 1.');
    expect(lines).toContain('Models removed: 1. Fields removed: 1.');
    expect(lines).toContain('Customer.age: text to integer');
    expect(lines).toContain('Field type changes: 1.');
    expect(lines).toContain('Archived values: 7. Archived tables: 1.');
    expect(
      describeApproval(publishApproval()).blocks.map((b) => b.code),
    ).toEqual(preview.methods.map((m) => m.code));
  });
});

describe('publish history', () => {
  it('groups a publish by id and uses the oldest parent, regardless of input order', () => {
    const [group, base] = groupHistory([...versions].reverse());
    expect(group).toMatchObject({
      id: 'draft-1',
      name: 'Better orders',
      before: 1,
      canUndo: true,
    });
    expect(group.versions.map((v) => v.version)).toEqual([3, 2]);
    expect(base.name).toBeNull();
  });
  it('does not merge separate publishes with the same name', () => {
    expect(
      groupHistory([
        ...versions,
        {
          ...versions[2],
          version: 4,
          parent: 3,
          publish: { draftId: 'other', name: 'Better orders' },
        },
      ]),
    ).toHaveLength(3);
  });
  it('does not undo through purged archives or an already undone branch', () => {
    expect(
      groupHistory(versions.map((v) => ({ ...v, purged: v.version === 2 })))[0]
        .canUndo,
    ).toBe(false);
    expect(
      groupHistory(versions.map((v) => ({ ...v, current: v.version === 1 })))[0]
        .canUndo,
    ).toBe(false);
  });
});

it('shows each replayed data step with upsert status and live counts', () => {
  const p = structuredClone(preview);
  p.versions[0].dataSteps = [
    {
      op: 'loadRecords',
      model: 'Order',
      mode: 'upsert',
      counts: { insert: 2, update: 3, unchanged: 4, rejected: 0 },
    },
    {
      op: 'extractModel',
      model: 'Order',
      counts: { rows: 9, distinct: 5, folded: 1, create: 3, matched: 2 },
    },
    {
      op: 'mergeRecords',
      model: 'Customer',
      counts: { removed: 2, references: { Order: 7 } },
    },
  ];
  const lines = publishLines(p).join('\n');
  expect(lines).toContain(
    'Load Order (upsert): 2 inserted, 3 updated, 4 unchanged, 0 rejected.',
  );
  expect(lines).toContain(
    'Extract Order: 9 rows, 5 distinct values, 1 folded, 3 created, 2 matched.',
  );
  expect(lines).toContain(
    'Merge Customer: 2 removed; references repointed (Order: 7).',
  );
});

it('includes only added or changed calculations, including cleared formulas', () => {
  const p = structuredClone(preview);
  p.fields = {
    Customer: {
      same: { type: 'integer', calculated: { value: 1 } },
      added: { type: 'integer', calculated: { value: 2 } },
    },
  };
  p.definition.models = {
    Customer: {
      fieldsAdded: ['added'],
      fieldsRemoved: [],
      fieldsChanged: [
        {
          field: 'same',
          from: { type: 'integer', calculated: { value: 1 } },
          to: { type: 'integer', label: 'New label', calculated: { value: 1 } },
        },
        {
          field: 'cleared',
          from: { type: 'integer', calculated: { value: 3 } },
          to: { type: 'integer' },
        },
      ],
    },
  };
  const lines = publishCalculations(p);
  expect(lines).toHaveLength(2);
  expect(lines.join(' ')).toContain('Add field Customer.added');
  expect(lines.join(' ')).toContain('Customer.cleared: remove calculation');
  expect(lines.join(' ')).not.toContain('Customer.same');
});
