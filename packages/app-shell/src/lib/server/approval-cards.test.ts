import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ApprovalRequiredError, type Command } from '../../engine/index.ts';
import { hostOwner } from '../../test/engine-principal.ts';
import { ApprovalCollection } from '../objects/Approval.ts';
import { describeApproval } from '../ui/approvals.ts';
import { publishDataLines } from '../ui/publish.ts';
import type { ApprovalView, PublishPreview } from '../ui/types.ts';
import { getApprovalView, listApprovalViews } from './approvals.ts';
import { requestCommandApproval, runCommand } from './builder.ts';
import { discardChanges } from './changes.ts';
import { previewDraft, startDraft } from './drafts.ts';
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
  // Structural commands wait as changes now; a stored card from an older
  // release is reproduced from the live host's own refusal.
  const live = await getHost();
  const pending = await live
    .execute(command, { author: harness.owner.id })
    .then(
      () => {
        throw new Error('expected the command to need approval');
      },
      (e) => {
        if (!(e instanceof ApprovalRequiredError)) throw e;
        return requestCommandApproval(live, command, e, harness.owner.id);
      },
    );
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
    const first = await host.create(hostOwner(host), 'Customer', {
      name: 'Acme',
      amount: 8,
      qty: 2,
      category: 'Food',
    });
    const second = await host.create(hostOwner(host), 'Customer', {
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
    await execute({
      type: 'defineModel',
      name: 'Order',
      label: 'Orders',
      fields: {
        name: { type: 'text' },
        customer: { type: 'reference', ref: 'Customer' },
      },
    });
    await host.create(hostOwner(host), 'Order', {
      name: 'First order',
      customer: second.id,
    });
    const merge = await card({
      type: 'mergeRecords',
      model: 'Customer',
      keep: String(first.id),
      merge: [String(second.id)],
    });
    expect(merge.text).toContain('1 record in Customers');
    expect(merge.text).toContain(
      '1 reference in Orders will point to the kept record.',
    );
    expect(merge.approval.preview).toMatchObject({
      referenceLabels: { Order: 'Orders' },
    });
    expect(merge.approval.preview).toMatchObject({
      keepLabel: 'Acme',
      removedLabels: ['Other'],
    });
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
    expect(undo.text).toContain('2 original stored values');
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
      await discardChanges();
    }
  }));

it('hydrates legacy merge reference labels through list, get and reused approval results', async () =>
  runAs(harness.owner, async () => {
    await execute({
      type: 'defineModel',
      name: 'MergeCustomer',
      label: 'Customers',
      fields: { name: { type: 'text' } },
    });
    await execute({
      type: 'defineModel',
      name: 'MergeOrder',
      label: 'Orders',
      fields: {
        name: { type: 'text' },
        customer: { type: 'reference', ref: 'MergeCustomer' },
      },
    });
    const host = await getHost();
    const kept = await host.create(hostOwner(host), 'MergeCustomer', {
      name: 'Acme',
    });
    const removed = await host.create(hostOwner(host), 'MergeCustomer', {
      name: `<b>Removed</b> ${'very long record label '.repeat(12)}`,
    });
    await host.create(hostOwner(host), 'MergeOrder', {
      name: 'First order',
      customer: removed.id,
    });
    const command: Command = {
      type: 'mergeRecords',
      model: 'MergeCustomer',
      keep: String(kept.id),
      merge: [String(removed.id)],
    };
    const fresh = await card(command);
    expect(fresh.text).toContain(
      '1 reference in Orders will point to the kept record.',
    );
    const collection = await ApprovalCollection.create({ db: harness.db });
    const row = await collection.get(fresh.approval.id);
    if (!row) throw new Error('Expected persisted merge approval');
    const preview = JSON.parse(row.preview);
    delete preview.referenceLabels;
    row.preview = JSON.stringify(preview);
    await row.save();
    const legacy = await card(command);
    const direct = await getApprovalView(row.id as string);
    expect(legacy.text).toContain(
      '1 reference in Orders will point to the kept record.',
    );
    expect(direct?.preview).toMatchObject({
      referenceLabels: { MergeOrder: 'Orders' },
    });
    expect(JSON.stringify(direct?.preview)).not.toContain(
      'Unrelated private label',
    );
    const reused = await card(command);
    expect(reused.approval).toMatchObject({
      id: row.id,
      preview: { referenceLabels: { MergeOrder: 'Orders' } },
    });
    await startDraft('Merge references', harness.owner.id);
    try {
      await runCommand(command, harness.owner.id, 'draft');
      const { preview } = await previewDraft();
      expect(preview.modelLabels).toMatchObject({
        MergeCustomer: 'Customers',
        MergeOrder: 'Orders',
      });
      expect(preview.modelLabels).not.toHaveProperty('Hidden');
      expect(
        publishDataLines(preview as unknown as PublishPreview).join(' '),
      ).toContain('1 reference in Orders');
    } finally {
      await discardChanges();
    }
    await execute(command);
    const undo = await card({ type: 'undo' });
    expect(undo.text).toContain(
      'recreates 1 removed record and points 1 reference back to those records.',
    );
    expect(undo.text).not.toContain('MergeOrder');
    if (process.env.SMRT_MERGE_APPROVAL_ARTIFACT)
      writeFileSync(
        process.env.SMRT_MERGE_APPROVAL_ARTIFACT,
        JSON.stringify({ merge: legacy.approval, undoMerge: undo.approval }),
      );
  }));
