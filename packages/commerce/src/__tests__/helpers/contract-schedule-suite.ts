import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { expect } from 'vitest';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../../collections/ContractLineItemCollection.js';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import {
  approveContractBillingSchedule,
  getContractBillingSchedule,
  issueContractMilestoneInvoice,
} from '../../contract-billing-schedule.js';
import { ContractStatus, InvoiceStatus } from '../../types/index.js';

/** Public commands exercised against native collections and the caller's exact executor. */
export async function proveContractSchedule(
  db: DatabaseInterface,
  concurrent = false,
): Promise<void> {
  const tenantId = randomUUID();
  let contractId = '';
  await withTenant({ tenantId }, async () => {
    const customer = await (await CustomerCollection.create({ db })).create({
      name: 'Milestone customer',
    });
    const component = await (
      await TaxComponentCollection.create({ db })
    ).create({ name: 'GST', percent: '5' });
    const code = await (await TaxCodeCollection.create({ db })).create({
      code: 'gst',
      name: 'GST',
      components: [{ taxComponentId: component.id!, compound: false }],
    });
    const contracts = await ContractCollection.create({ db });
    const contract = await contracts.create({
      _meta_type: '@happyvertical/smrt-commerce:Order',
      customerId: customer.id!,
      currency: 'CAD',
    });
    contractId = contract.id!;
    await (await ContractLineItemCollection.create({ db })).create({
      contractId,
      description: 'Agreed fixed scope',
      quantity: 1,
      unitPrice: 10000,
      taxMode: 'override',
      taxCodeId: code.id,
    });
    const accepted = (await contracts.get(
      { id: contractId },
      { cache: false },
    ))!;
    accepted.status = ContractStatus.ACCEPTED;
    await accepted.save();
    const schedule = {
      db,
      tenantId,
      contractId,
      requestId: 'approve-1',
      expectedRevision: 0,
      approvalEvidenceRef: 'signed:1',
      taxPolicyEvidenceRef: 'tax-policy:1',
      currency: 'CAD',
      basis: 'net' as const,
      amendmentMinor: 0,
      milestones: [
        { key: 'start', label: 'Start', amountMinor: 4000 },
        { key: 'finish', label: 'Finish', amountMinor: 6000 },
      ],
    };
    for (const change of [
      { amendmentMinor: 1 },
      { currency: 'USD' },
      { basis: 'gross' as const },
      { milestones: [{ key: 'wrong', label: 'Wrong', amountMinor: 10001 }] },
    ])
      await expect(
        approveContractBillingSchedule({ ...schedule, ...change }),
      ).rejects.toThrow();
    const approved = await approveContractBillingSchedule(schedule);
    expect(approved).toMatchObject({ revision: 1, approvedTotalMinor: 10000 });
    expect(await approveContractBillingSchedule(schedule)).toEqual(approved);
    await expect(
      approveContractBillingSchedule({
        ...schedule,
        approvalEvidenceRef: 'different',
      }),
    ).rejects.toThrow('request changed');
    const forged = (await contracts.get({ id: contractId }, { cache: false }))!;
    forged.billingScheduleJson = '';
    await expect(forged.save()).rejects.toThrow('schedule commands');
    await expect(forged.delete()).rejects.toThrow('history cannot be deleted');
    const invoices = await InvoiceCollection.create({ db });
    async function draft(amount: number, dbOverride = db) {
      const invoice = await (
        await InvoiceCollection.create({ db: dbOverride })
      ).create({
        customerId: customer.id!,
        contractId,
        currency: 'CAD',
        invoiceNumber: randomUUID(),
      });
      await (await InvoiceLineItemCollection.create({ db: dbOverride })).create(
        {
          invoiceId: invoice.id!,
          description: 'Approved milestone',
          quantity: 1,
          unitPrice: amount,
          taxMode: 'override',
          taxCodeId: code.id,
        },
      );
      return (await (
        await InvoiceCollection.create({ db: dbOverride })
      ).get({ id: invoice.id! }, { cache: false }))!;
    }
    const abandoned = await draft(4000);
    abandoned.cancel();
    await abandoned.save();
    expect(
      getContractBillingSchedule(
        (await contracts.get({ id: contractId }, { cache: false }))!,
      )?.claims,
    ).toEqual([]);
    await expect(
      invoices.create({
        customerId: customer.id!,
        contractId,
        currency: 'CAD',
        invoiceNumber: randomUUID(),
        status: InvoiceStatus.SENT,
      }),
    ).rejects.toThrow('issueContractMilestoneInvoice');
    const first = await draft(4000);
    first.markSent();
    await expect(first.save()).rejects.toThrow('issueContractMilestoneInvoice');
    const issue = {
      db,
      tenantId,
      contractId,
      requestId: 'issue-start',
      revision: 1,
      milestoneKey: 'start',
      invoiceId: first.id!,
      approvedMoney: { netMinor: 4000, taxMinor: 200, grossMinor: 4200 },
      invoiceApprovalEvidenceRef: 'invoice-approved:1',
    };
    await expect(
      issueContractMilestoneInvoice({
        ...issue,
        approvedMoney: { netMinor: 4000, taxMinor: 0, grossMinor: 4000 },
      }),
    ).rejects.toThrow('approved amounts');
    expect(
      (await invoices.get({ id: first.id! }, { cache: false }))?.status,
    ).toBe(InvoiceStatus.DRAFT);
    if (!db.transaction) throw new Error('Transaction required');
    await expect(
      db.transaction(async (tx) => {
        await issueContractMilestoneInvoice({ ...issue, db: tx });
        throw new Error('parent rollback');
      }),
    ).rejects.toThrow('parent rollback');
    expect(
      (await invoices.get({ id: first.id! }, { cache: false }))?.status,
    ).toBe(InvoiceStatus.DRAFT);
    expect(
      getContractBillingSchedule(
        (await contracts.get({ id: contractId }, { cache: false }))!,
      )?.claims,
    ).toEqual([]);
    const claim = await issueContractMilestoneInvoice(issue);
    expect(claim.moneySnapshotId).toBeTruthy();
    expect(await issueContractMilestoneInvoice(issue)).toEqual(claim);
    await expect(
      issueContractMilestoneInvoice({
        ...issue,
        invoiceApprovalEvidenceRef: 'changed',
      }),
    ).rejects.toThrow('request changed');
    const frozen = (await invoices.get({ id: first.id! }, { cache: false }))!;
    expect(frozen).toMatchObject({
      status: InvoiceStatus.SENT,
      subtotal: 4000,
      taxAmount: 200,
      totalAmount: 4200,
    });
    frozen.cancel();
    await frozen.save();
    await expect(
      issueContractMilestoneInvoice({
        ...issue,
        requestId: 'rebill-cancelled',
      }),
    ).rejects.toThrow('already consumed');
    await expect(
      approveContractBillingSchedule({
        ...schedule,
        expectedRevision: 1,
        requestId: 'bad-amendment',
        amendmentMinor: -1000,
        milestones: [{ key: 'finish', label: 'Finish', amountMinor: 9000 }],
      }),
    ).rejects.toThrow('issued milestone');
    const amended = {
      ...schedule,
      expectedRevision: 1,
      requestId: 'approve-2',
      approvalEvidenceRef: 'change-order:1',
      amendmentMinor: 1000,
      milestones: [
        ...schedule.milestones,
        { key: 'extra', label: 'Extra scope', amountMinor: 1000 },
      ],
    };
    await expect(
      db.transaction(async (tx) => {
        await approveContractBillingSchedule({ ...amended, db: tx });
        throw new Error('amendment rollback');
      }),
    ).rejects.toThrow('amendment rollback');
    expect(
      getContractBillingSchedule(
        (await contracts.get({ id: contractId }, { cache: false }))!,
      )?.revisions,
    ).toHaveLength(1);
    expect(await approveContractBillingSchedule(amended)).toMatchObject({
      revision: 2,
      approvedTotalMinor: 11000,
    });
    expect(await approveContractBillingSchedule(schedule)).toEqual(approved);
    expect(
      (await contracts.get({ id: contractId }, { cache: false }))?.subtotal,
    ).toBe(10000);
    await expect(
      approveContractBillingSchedule({ ...amended, requestId: 'stale' }),
    ).rejects.toThrow('revision changed');
    const last = await draft(6000);
    const finalIssue = {
      ...issue,
      requestId: 'issue-finish',
      revision: 2,
      milestoneKey: 'finish',
      invoiceId: last.id!,
      approvedMoney: { netMinor: 6000, taxMinor: 300, grossMinor: 6300 },
    };
    await expect(
      issueContractMilestoneInvoice({ ...finalIssue, revision: 1 }),
    ).rejects.toThrow('revision changed');
    if (concurrent) {
      const competitor = await draft(6000);
      const results = await Promise.allSettled([
        issueContractMilestoneInvoice(finalIssue),
        issueContractMilestoneInvoice({
          ...finalIssue,
          requestId: 'competing-finish',
          invoiceId: competitor.id!,
        }),
      ]);
      expect(
        results.filter((entry) => entry.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((entry) => entry.status === 'rejected'),
      ).toHaveLength(1);
    } else await issueContractMilestoneInvoice(finalIssue);
    const state = getContractBillingSchedule(
      (await contracts.get({ id: contractId }, { cache: false }))!,
    )!;
    expect(state.claims).toHaveLength(2);
    expect(state.revisions).toHaveLength(2);
    expect(state.originalAmountMinor).toBe(10000);
    const billed = state.claims[1];
    const invoiceLines = await InvoiceLineItemCollection.create({ db });
    const billedLines = await invoiceLines.findByInvoice(billed.invoiceId);
    const credit = await invoices.create({
      kind: 'credit_note',
      creditedInvoiceId: billed.invoiceId,
      customerId: customer.id!,
      currency: 'CAD',
      invoiceNumber: randomUUID(),
    });
    await invoiceLines.create({
      invoiceId: credit.id!,
      creditedLineId: billedLines[0].id!,
      description: 'Approved credit',
      quantity: 1,
      unitPrice: 6000,
    });
    const preparedCredit = (await invoices.get(
      { id: credit.id! },
      { cache: false },
    ))!;
    preparedCredit.markSent();
    await preparedCredit.save();
    expect(
      (await invoices.get({ id: billed.invoiceId }, { cache: false }))
        ?.creditedAmount,
    ).toBe(6300);
    await expect(
      issueContractMilestoneInvoice({
        ...finalIssue,
        requestId: 'rebill-credited',
      }),
    ).rejects.toThrow('already consumed');
    expect(
      getContractBillingSchedule(
        (await contracts.get({ id: contractId }, { cache: false }))!,
      )?.claims,
    ).toEqual(state.claims);
    state.claims.length = 0;
    expect(
      getContractBillingSchedule(
        (await contracts.get({ id: contractId }, { cache: false }))!,
      )?.claims,
    ).toHaveLength(2);
    // Gross ceilings are independently explicit; pre-existing issued invoices cannot be hidden.
    const grossContract = await contracts.create({
      _meta_type: '@happyvertical/smrt-commerce:Agreement',
      customerId: customer.id!,
      currency: 'CAD',
    });
    await (await ContractLineItemCollection.create({ db })).create({
      contractId: grossContract.id!,
      description: 'Gross agreed scope',
      quantity: 1,
      unitPrice: 100,
      taxMode: 'override',
      taxCodeId: code.id,
    });
    const grossAccepted = (await contracts.get(
      { id: grossContract.id! },
      { cache: false },
    ))!;
    grossAccepted.status = ContractStatus.ACCEPTED;
    await grossAccepted.save();
    const grossSchedule = {
      ...schedule,
      contractId: grossContract.id!,
      requestId: 'gross',
      basis: 'gross' as const,
      milestones: [
        { key: 'gross', label: 'Gross milestone', amountMinor: 105 },
      ],
    };
    expect(await approveContractBillingSchedule(grossSchedule)).toMatchObject({
      approvedTotalMinor: 105,
      basis: 'gross',
    });
    const grossDraft = await invoices.create({
      customerId: customer.id!,
      contractId: grossContract.id!,
      currency: 'CAD',
      invoiceNumber: randomUUID(),
    });
    await invoiceLines.create({
      invoiceId: grossDraft.id!,
      description: 'Gross milestone',
      quantity: 1,
      unitPrice: 100,
      taxMode: 'override',
      taxCodeId: code.id,
    });
    expect(
      await issueContractMilestoneInvoice({
        ...issue,
        contractId: grossContract.id!,
        invoiceId: grossDraft.id!,
        requestId: 'gross-issue',
        milestoneKey: 'gross',
        approvedMoney: { netMinor: 100, taxMinor: 5, grossMinor: 105 },
      }),
    ).toMatchObject({ invoiceId: grossDraft.id });
    const oldContract = await contracts.create({
      _meta_type: '@happyvertical/smrt-commerce:Order',
      customerId: customer.id!,
      currency: 'CAD',
    });
    const oldInvoice = await invoices.create({
      customerId: customer.id!,
      contractId: oldContract.id!,
      currency: 'CAD',
      invoiceNumber: randomUUID(),
    });
    oldInvoice.markSent();
    await oldInvoice.save();
    oldContract.status = ContractStatus.ACCEPTED;
    await oldContract.save();
    await expect(
      approveContractBillingSchedule({
        ...schedule,
        contractId: oldContract.id!,
        milestones: [{ key: 'zero', label: 'Zero', amountMinor: 0 }],
      }),
    ).rejects.toThrow('Existing issued');
  });
  const foreignTenant = randomUUID();
  await withTenant({ tenantId: foreignTenant }, async () => {
    const request = {
      db,
      tenantId,
      contractId,
      requestId: 'foreign',
      revision: 1,
      milestoneKey: 'start',
      invoiceId: 'foreign',
      approvedMoney: { netMinor: 0, taxMinor: 0, grossMinor: 0 },
      invoiceApprovalEvidenceRef: 'foreign',
    };
    await expect(issueContractMilestoneInvoice(request)).rejects.toThrow(
      'active tenant',
    );
    await expect(
      issueContractMilestoneInvoice({ ...request, tenantId: foreignTenant }),
    ).rejects.toThrow();
  });
}
