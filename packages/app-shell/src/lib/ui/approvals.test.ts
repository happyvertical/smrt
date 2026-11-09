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
    expect(d.code).toBe('return 1;');
    expect(d.codeTitle).toBe('Chore.complete()');
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
