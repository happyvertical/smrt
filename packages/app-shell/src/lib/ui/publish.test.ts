import { describe, expect, it } from 'vitest';
import {
  preview,
  publishApproval,
  versions,
} from '../../test/draft-fixtures.ts';
import { describeApproval } from './approvals.ts';
import { groupHistory, publishLines } from './publish.ts';

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
