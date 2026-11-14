import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Command } from '../../engine/index.ts';
import { describeApproval } from '../ui/approvals.ts';
import type { ApprovalView } from '../ui/types.ts';
import { listApprovalViews } from './approvals.ts';
import { runCommand } from './builder.ts';
import { discardNow, previewDraft, startDraft } from './drafts.ts';
import { getHost } from './host.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';

let harness: ShellHarness;
beforeAll(async () => {
  harness = await openShell();
});
afterAll(async () => {
  await harness.close();
});
const execute = async (command: Command) =>
  (await getHost()).execute(command, {
    author: harness.owner.id,
    approved: true,
  });
async function card(command: Command) {
  const pending = (await runCommand(command, harness.owner.id, 'live')) as {
    approvalId: string;
  };
  const approval = (await listApprovalViews()).find(
    (view) => view.id === pending.approvalId,
  );
  expect(approval).toBeTruthy();
  if (!approval) throw new Error('Expected a stored approval');
  return {
    approval,
    text: describeApproval(approval as ApprovalView).lines.join(' '),
  };
}
it('projects real engine previews through stored approvals into card text', async () =>
  runAs(harness.owner, async () => {
    await execute({
      type: 'defineModel',
      name: 'Customer',
      label: 'Customers',
      fields: {
        name: { type: 'text' },
        amount: { type: 'integer', label: 'Invoice total' },
        qty: { type: 'integer', label: 'Quantity' },
        category: { type: 'text', label: 'Category name' },
      },
    });
    await execute({
      type: 'defineModel',
      name: 'Hidden',
      label: 'Unrelated private label',
      fields: { name: { type: 'text' } },
    });
    const host = await getHost();
    const first = await host.create('Customer', {
      name: 'Acme',
      amount: 8,
      qty: 2,
      category: 'Food',
    });
    const second = await host.create('Customer', {
      name: 'Other',
      amount: 3,
      qty: 1,
      category: 'Food',
    });
    const insert = await card({
      type: 'loadRecords',
      model: 'Customer',
      mode: 'insert',
      rows: [{ name: 'Third' }],
    });
    expect(insert.text).toContain('1 inserted, 0 updated');
    expect(insert.text).not.toContain('overwrite');
    expect(insert.approval.preview).not.toHaveProperty('referenceLabels');
    const upsert = await card({
      type: 'loadRecords',
      model: 'Customer',
      mode: 'upsert',
      key: ['name'],
      rows: [{ name: 'Acme', amount: 9 }],
    });
    expect(upsert.text).toContain('1 updated');
    expect(upsert.text).toContain('overwrite stored values');
    const merge = await card({
      type: 'mergeRecords',
      model: 'Customer',
      keep: String(first.id),
      merge: [String(second.id)],
    });
    expect(merge.text).toContain('1 record in Customers');
    expect(merge.text).toContain('Acme');
    expect(JSON.stringify(merge.approval.preview)).not.toContain(
      'Unrelated private label',
    );
    const extract = await card({
      type: 'extractModel',
      model: 'Customer',
      field: 'category',
      into: 'Category',
    });
    expect(extract.text).toContain('Category name');
    expect(extract.text).toContain('2 records will be linked');
    const calculated = { col: 'qty' } as const;
    const command: Command = {
      type: 'setCalculation',
      model: 'Customer',
      field: 'amount',
      calculated,
    };
    const plain = await card(command);
    expect(plain.text).toContain('2 stored values will be overwritten');
    expect(plain.text).toContain('Quantity');
    await execute(command);
    const replacement = await card({
      ...command,
      calculated: { op: 'add', left: calculated, right: { value: 1 } },
    });
    expect(replacement.text).toContain('from Quantity to');
    expect(replacement.text).not.toContain('stored values will be overwritten');
    const clear = await card({ ...command, calculated: null });
    expect(clear.text).toContain('Removes the calculation');
    expect(clear.text).toContain('keep their current values');
    expect(clear.text).toContain('Future edits can set this field directly');
    const undo = await card({ type: 'undo' });
    expect(undo.text).toContain('original value');
    await execute({
      type: 'defineModel',
      name: 'Empty',
      fields: { amount: { type: 'integer' }, qty: { type: 'integer' } },
    });
    const empty = await card({ ...command, model: 'Empty' });
    expect(empty.text).toContain('0 records will be recalculated');
    expect(empty.text).not.toContain('will be overwritten');
  }));

it('limits stored reference labels to models used by the card', async () =>
  runAs(harness.owner, async () => {
    const result = await card({
      type: 'loadRecords',
      model: 'Customer',
      mode: 'insert',
      rows: [{ name: 'Metadata only' }],
    });
    expect(result.approval.preview).not.toHaveProperty('referenceLabels');
  }));
it('projects only data-step model labels into publish previews', async () =>
  runAs(harness.owner, async () => {
    await startDraft('Data labels', harness.owner.id);
    try {
      await runCommand(
        {
          type: 'loadRecords',
          model: 'Customer',
          mode: 'insert',
          rows: [{ name: 'Draft import' }],
        },
        harness.owner.id,
        'draft',
      );
      const { preview } = await previewDraft();
      expect(preview.modelLabels).toEqual({ Customer: 'Customers' });
    } finally {
      await discardNow();
    }
  }));
