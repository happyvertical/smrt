/** Shared real-database allocation acceptance contract (SQLite and PostgreSQL). */
import { randomUUID } from 'node:crypto';
import { AssetCollection } from '@happyvertical/smrt-assets';
import {
  ContractCollection,
  ContractLineItemCollection,
  ensureCommerceTenant,
  InvoiceCollection,
  InvoiceLineItemCollection,
  VendorCollection,
} from '@happyvertical/smrt-commerce';
import {
  GlobalInterceptors,
  isApiActionEnabledForObject,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExpenseCollection } from '../../collections/ExpenseCollection.js';
import { ExpenseReceiptCollection } from '../../collections/ExpenseReceiptCollection.js';
import {
  bindExpenseAllocationPortion,
  EXPENSE_ALLOCATION_INVOICE_SOURCE,
  type ExpenseAllocationBillingAuthority,
  getExpenseAllocationPortionPosition,
  type ReviewExpenseAllocationInput,
  releaseExpenseAllocationPortion,
  reserveExpenseAllocationPortion,
  resolveExpenseAllocationPortion,
  reviewExpenseAllocation,
} from '../../expense-allocation.js';
import type { Expense } from '../../models/Expense.js';
import {
  ExpenseAllocationPortion,
  ExpenseAllocationRevision,
} from '../../models/ExpenseAllocation.js';

/** Share executable behavior with the migrated PostgreSQL lane. */
export function defineAllocationSuite(getDb: () => DatabaseInterface): void {
  describe('reviewed allocation contract', () => {
    let tenantId: string;
    let userId: string;
    let profileId: string;
    let expenses: ExpenseCollection;
    let source: Expense;
    let input: ReviewExpenseAllocationInput;
    let calls: string[];
    const authority: ExpenseAllocationBillingAuthority = {
      async authorizeSource(principal, _sourceId, executor, context) {
        expect(principal.tenantId).toBe(tenantId);
        expect(executor).toBeTruthy();
        expect([
          'reviewAllocation',
          'reserveAllocation',
          'bindAllocation',
          'releaseAllocation',
          'withdrawAllocation',
        ]).toContain(context.action);
        if (
          context.action === 'reviewAllocation' ||
          context.action === 'withdrawAllocation'
        )
          expect(context.portion).toBeUndefined();
        else expect(context.portion).toMatchObject({ amountMinor: 60 });
      },
      async authorizeUnsplitTarget(principal, target, executor) {
        expect(principal.tenantId).toBe(tenantId);
        expect(target.sourceExpenseId).toBeTruthy();
        expect(executor).toBeTruthy();
      },
      async authorizeInvoice(principal, _target, _invoiceId, executor) {
        expect(principal.tenantId).toBe(tenantId);
        expect(executor).toBeTruthy();
      },
      async authorizeDraft(principal, _target, draft, executor) {
        expect(principal.tenantId).toBe(tenantId);
        expect(draft.id).toBeTruthy();
        expect(executor).toBeTruthy();
      },
      async authorizeTarget(principal, target, executor) {
        expect(principal.tenantId).toBe(tenantId);
        expect(principal.userId).toBe(userId);
        expect(executor).toBeTruthy();
        calls.push(target.costObjectId);
      },
    };
    const run = <T>(
      fn: () => Promise<T>,
      grants = ['expenses.recordReview', 'expenses.read'],
    ) =>
      withTenant(
        {
          tenantId,
          userId,
          user: { id: userId, profileId },
          permissions: new Set(grants),
        },
        fn,
      );
    beforeEach(async () => {
      enableTenancy();
      tenantId = randomUUID();
      userId = randomUUID();
      profileId = randomUUID();
      calls = [];
      expenses = await ExpenseCollection.create({ db: getDb() });
      await run(async () => {
        const targets = [];
        for (let i = 0; i < 2; i++) {
          const item = await expenses.create({
            amount: 1,
            currency: 'CAD',
            incurredOn: '2026-11-01',
          });
          await item.save();
          targets.push(item.id!);
        }
        source = await expenses.create({
          costObjectType: '@happyvertical/smrt-expenses:Expense',
          costObjectId: targets[0],
          amount: 100,
          currency: 'CAD',
          incurredOn: '2026-11-01',
          paidBy: 'person',
          paidByProfileId: profileId,
          reimbursable: true,
        });
        await source.save();
        await source.review({ reviewerProfileId: profileId });
        input = {
          sourceExpenseId: source.id!,
          expectedSourceRevision: source.updated_at!,
          requestId: randomUUID(),
          reviewEvidence: 'Reviewed synthetic allocation',
          portions: targets.map((id, index) => ({
            portionKey: `part-${index}`,
            costObjectType: '@happyvertical/smrt-expenses:Expense',
            costObjectId: id,
            costCodeRef: `code-${index}`,
            amountMinor: index === 0 ? 60 : 40,
          })),
        };
      });
    });
    afterEach(() => {
      disableTenancy();
      GlobalInterceptors.unregister('allocation-failure');
    });
    async function draft(portionId: string) {
      await ensureCommerceTenant(getDb(), tenantId);
      const invoices = await InvoiceCollection.create({ db: getDb() });
      const invoice = await invoices.create({
        invoiceNumber: `synthetic-${randomUUID()}`,
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db: getDb() });
      const line = await lines.create({
        invoiceId: invoice.id!,
        description: 'Synthetic allocated material',
        quantity: 1,
        unitPrice: 60,
        sourceType: EXPENSE_ALLOCATION_INVOICE_SOURCE,
        sourceId: portionId,
      });
      return { invoice, line, lines, invoices };
    }
    it('reserves host draft once, bridges the same claim, blocks pointer/namespace/delete/duplicate bypasses, and freezes issued lineage', async () =>
      run(async () => {
        const result = await expenses.reviewAllocation(input, authority);
        const portionId = result.portions[0].portionId;
        const request = {
          portionId,
          requestId: randomUUID(),
          draftType: '@host/app:Draft',
          draftId: randomUUID(),
        };
        const reservation = await reserveExpenseAllocationPortion(
          getDb(),
          request,
          authority,
        );
        expect(
          await getExpenseAllocationPortionPosition(
            getDb(),
            portionId,
            authority,
          ),
        ).toMatchObject({
          available: false,
          reservation: {
            reservationId: reservation.id,
            draftType: request.draftType,
            draftId: request.draftId,
            invoiceId: null,
            issued: false,
          },
        });
        expect(
          (await reserveExpenseAllocationPortion(getDb(), request, authority))
            .id,
        ).toBe(reservation.id);
        await expect(
          reserveExpenseAllocationPortion(
            getDb(),
            { ...request, requestId: randomUUID() },
            authority,
          ),
        ).rejects.toThrow('capacity');
        const { invoice, line, lines, invoices } = await draft(portionId);
        invoice.markSent();
        await expect(invoice.save()).rejects.toThrow();
        await invoice.loadFromId();
        const bind = {
          invoiceId: invoice.id!,
          invoiceLineId: line.id!,
          requestId: randomUUID(),
        };
        await bindExpenseAllocationPortion(
          getDb(),
          reservation.id!,
          bind,
          authority,
        );
        expect(
          (
            await bindExpenseAllocationPortion(
              getDb(),
              reservation.id!,
              bind,
              authority,
            )
          ).relatedReservationId,
        ).toBe(reservation.id);
        await line.loadFromId();
        expect(line.sourceReservationId).toBe(reservation.id);
        line.sourceType = 'manual';
        line.sourceId = '';
        line.sourceReservationId = null;
        await expect(line.save()).rejects.toThrow();
        await line.loadFromId();
        await expect(line.delete()).rejects.toThrow();
        await expect(lines.delete(line.id!)).rejects.toThrow();
        await expect(invoices.delete(invoice.id!)).rejects.toThrow();
        await expect(
          lines.create({
            invoiceId: invoice.id!,
            unitPrice: 60,
            sourceType: EXPENSE_ALLOCATION_INVOICE_SOURCE,
            sourceId: portionId,
            sourceReservationId: reservation.id,
          }),
        ).rejects.toThrow();
        const duplicate = await lines.create({
          invoiceId: invoice.id!,
          unitPrice: 60,
          sourceType: EXPENSE_ALLOCATION_INVOICE_SOURCE,
          sourceId: portionId,
        });
        await invoice.loadFromId();
        invoice.markSent();
        await expect(invoice.save()).rejects.toThrow();
        await duplicate.delete();
        await invoice.loadFromId();
        invoice.markSent();
        await invoice.save();
        expect(
          await getExpenseAllocationPortionPosition(
            getDb(),
            portionId,
            authority,
          ),
        ).toMatchObject({
          available: false,
          reservation: {
            reservationId: reservation.id,
            invoiceId: invoice.id,
            issued: true,
          },
        });
        await expect(
          releaseExpenseAllocationPortion(
            getDb(),
            reservation.id!,
            randomUUID(),
            authority,
          ),
        ).rejects.toThrow('issued');
        await source.loadFromId();
        await expect(
          expenses.reviewAllocation(
            {
              ...input,
              expectedSourceRevision: source.updated_at!,
              requestId: randomUUID(),
            },
            authority,
          ),
        ).rejects.toThrow('reservations');
        expect(
          (await resolveExpenseAllocationPortion(getDb(), portionId, authority))
            .amountMinor,
        ).toBe(60);
      }));
    it('withdraws a bound draft and supersedes atomically; competing bind calls cannot claim a second line', async () =>
      run(async () => {
        const result = await expenses.reviewAllocation(input, authority);
        const portionId = result.portions[0].portionId;
        const reservation = await reserveExpenseAllocationPortion(
          getDb(),
          {
            portionId,
            requestId: randomUUID(),
            draftType: '@host/app:Draft',
            draftId: randomUUID(),
          },
          authority,
        );
        const first = await draft(portionId);
        const second = await draft(portionId);
        const attempts = await Promise.allSettled(
          [first, second].map(({ invoice, line }) =>
            bindExpenseAllocationPortion(
              getDb(),
              reservation.id!,
              {
                invoiceId: invoice.id!,
                invoiceLineId: line.id!,
                requestId: randomUUID(),
              },
              authority,
            ),
          ),
        );
        expect(
          attempts.filter((outcome) => outcome.status === 'fulfilled'),
        ).toHaveLength(1);
        const winning = attempts[0].status === 'fulfilled' ? first : second;
        let failed = false;
        GlobalInterceptors.register({
          name: 'allocation-failure',
          beforeSave: async (object) => {
            if (
              (object as { id?: string }).id === winning.line.id &&
              (object as { sourceReservationId?: string })
                .sourceReservationId === null
            ) {
              failed = true;
              throw new Error('injected unbind failure');
            }
          },
        });
        await expect(
          releaseExpenseAllocationPortion(
            getDb(),
            reservation.id!,
            randomUUID(),
            authority,
          ),
        ).rejects.toThrow();
        expect(failed).toBe(true);
        GlobalInterceptors.unregister('allocation-failure');
        await winning.line.loadFromId();
        expect(winning.line.sourceReservationId).toBe(reservation.id);

        await releaseExpenseAllocationPortion(
          getDb(),
          reservation.id!,
          randomUUID(),
          authority,
        );
        await winning.line.loadFromId();
        expect(winning.line.sourceReservationId).toBeNull();
        await source.loadFromId();
        const revised = await expenses.reviewAllocation(
          {
            ...input,
            expectedSourceRevision: source.updated_at!,
            requestId: randomUUID(),
            portions: input.portions.map((portion, i) => ({
              ...portion,
              amountMinor: i ? 25 : 75,
            })),
          },
          authority,
        );
        expect(revised.revision.previousRevisionId).toBe(result.revision.id);
      }));
    it('counts two receipts as one spend and freezes receipt provenance through junction deletion', async () =>
      run(async () => {
        const assets = await AssetCollection.create({ db: getDb() });
        const receipts = await ExpenseReceiptCollection.create({ db: getDb() });
        const links = [];
        for (let index = 0; index < 2; index++) {
          const asset = await assets.create({
            name: `synthetic-${index}.pdf`,
            mimeType: 'application/pdf',
            sourceUri: `file:///synthetic/${randomUUID()}.pdf`,
          });
          links.push(
            await receipts.attachReceipt({
              expenseId: source.id!,
              assetId: asset.id!,
              contentSha256: String(index + 1).repeat(64),
            }),
          );
        }
        await expenses.reviewAllocation(input, authority);
        expect(await expenses.totalsByCurrency()).toEqual({
          CAD: { amount: 100, count: 1 },
        });
        await expect(links[0].delete()).rejects.toThrow('immutable');
        await expect(
          receipts.detach(source.id!, links[1].assetId),
        ).rejects.toThrow();
        await expect(links[0].save()).rejects.toThrow('immutable');
        await source.loadFromId();
        await expenses.withdrawAllocation(
          {
            sourceExpenseId: source.id!,
            expectedActiveRevisionId: source.activeAllocationRevisionId!,
            expectedSourceRevision: source.updated_at!,
            requestId: randomUUID(),
            reviewEvidence: 'Unbilled correction retains original evidence',
          },
          authority,
        );
        await expect(links[0].delete()).rejects.toThrow('immutable');
      }));
    it('keeps commitment, refund, reimbursement and supplier reporting on the original accounting source', async () =>
      run(async () => {
        const vendor = await (
          await VendorCollection.create({ db: getDb() })
        ).create({ profileId: randomUUID() });
        const contract = await (
          await ContractCollection.create({ db: getDb() })
        ).create({
          _meta_type: 'PurchaseOrder',
          vendorId: vendor.id!,
          currency: 'CAD',
          reference: `synthetic-${randomUUID()}`,
        } as never);
        await (await ContractLineItemCollection.create({ db: getDb() })).create(
          {
            contractId: contract.id!,
            description: 'Synthetic commitment',
            quantity: 1,
            unitPrice: 100,
          },
        );
        const original = await expenses.create({
          amount: 100,
          currency: 'CAD',
          incurredOn: '2026-11-01',
          paidBy: 'person',
          paidByProfileId: profileId,
          reimbursable: true,
          commitmentId: contract.id!,
          costObjectType: input.portions[0].costObjectType,
          costObjectId: input.portions[0].costObjectId,
        });
        await original.review({ reviewerProfileId: profileId });
        await expenses.reviewAllocation(
          {
            ...input,
            sourceExpenseId: original.id!,
            expectedSourceRevision: original.updated_at!,
            requestId: randomUUID(),
          },
          authority,
        );
        expect(await expenses.commitmentPosition(contract.id!)).toMatchObject({
          drawn: 100,
          open: 0,
          countedExpenseIds: [original.id],
        });
        const refund = await expenses.create({
          amount: -20,
          currency: 'CAD',
          incurredOn: '2026-11-02',
          refundOfId: original.id!,
          refundRecipient: JSON.stringify({ kind: 'person', profileId }),
          commitmentId: contract.id!,
          costObjectType: input.portions[0].costObjectType,
          costObjectId: input.portions[0].costObjectId,
        });
        await refund.review({ reviewerProfileId: profileId });
        expect(await expenses.commitmentPosition(contract.id!)).toMatchObject({
          drawn: 80,
          open: 20,
        });
        expect(await expenses.refundPosition(original.id!)).toMatchObject({
          sourceAmount: 100,
          refundedAmount: 20,
          remainingAmount: 80,
        });
        expect(
          await expenses.reimbursementPosition(original.id!),
        ).toMatchObject({ remainingAmount: 80 });
        const facts = await expenses.listReviewedTaxFacts({
          tenantId,
          from: '2026-11-01',
          to: '2026-11-02',
        });
        expect(
          facts.filter((fact) => fact.expenseId === original.id),
        ).toHaveLength(1);
        expect(facts.some((fact) => fact.expenseId === refund.id)).toBe(true);
        await original.loadFromId();
        await expenses.withdrawAllocation(
          {
            sourceExpenseId: original.id!,
            expectedActiveRevisionId: original.activeAllocationRevisionId!,
            expectedSourceRevision: original.updated_at!,
            requestId: randomUUID(),
            reviewEvidence: 'Restore unbilled original commitment attribution',
          },
          authority,
        );
        expect(await expenses.commitmentPosition(contract.id!)).toMatchObject({
          drawn: 80,
          open: 20,
        });
        expect(
          await expenses.reimbursementPosition(original.id!),
        ).toMatchObject({ remainingAmount: 80 });
        expect(await expenses.totalsByCurrency()).toEqual({
          CAD: { amount: 180, count: 3 },
        });
      }));
    it('exposes only exact bounded economic facts and refuses fresh billing after any linked refund', async () =>
      run(async () => {
        const original = await expenses.create({
          amount: 100,
          currency: 'CAD',
          incurredOn: '2026-11-01',
          paidBy: 'company',
          reimbursable: false,
          financialBreakdown: JSON.stringify({
            currency: 'CAD',
            subtotal: 100,
            taxes: [],
            total: 100,
          }),
        });
        await original.review({ reviewerProfileId: profileId });
        const result = await expenses.reviewAllocation(
          {
            ...input,
            sourceExpenseId: original.id!,
            expectedSourceRevision: original.updated_at!,
            requestId: randomUUID(),
          },
          authority,
        );
        const portionId = result.portions[0].portionId;
        expect(
          await resolveExpenseAllocationPortion(getDb(), portionId, authority),
        ).toMatchObject({
          costBasisMinor: 60,
          hasSupplierTax: false,
          hasRefunds: false,
          paidBy: 'company',
          reimbursable: false,
        });
        await expenses.create({
          amount: -20,
          currency: 'CAD',
          incurredOn: '2026-11-02',
          refundOfId: original.id!,
        });
        const bounded = await resolveExpenseAllocationPortion(
          getDb(),
          portionId,
          authority,
        );
        expect(bounded).toMatchObject({
          costBasisMinor: null,
          hasRefunds: true,
        });
        expect(bounded).not.toHaveProperty('paidByProfileId');
        expect(bounded).not.toHaveProperty('financialBreakdown');
        expect(bounded).not.toHaveProperty('sourceAmount');
        await expect(
          reserveExpenseAllocationPortion(
            getDb(),
            {
              portionId,
              requestId: randomUUID(),
              draftType: '@host/app:Draft',
              draftId: randomUUID(),
            },
            authority,
          ),
        ).rejects.toThrow('refunded');
      }));
    it('preserves zero-valued unsplit source counts in target totals', async () =>
      run(async () => {
        const zero = await expenses.create({
          amount: 0,
          currency: 'CAD',
          incurredOn: '2026-11-01',
          costObjectType: input.portions[0].costObjectType,
          costObjectId: input.portions[0].costObjectId,
        });
        await zero.review({ reviewerProfileId: profileId });
        expect(
          await expenses.totalsByCurrency({
            where: {
              id: zero.id,
              costObjectType: zero.costObjectType,
              costObjectId: zero.costObjectId,
            },
          }),
        ).toEqual({ CAD: { amount: 0, count: 1 } });
        expect(
          await expenses.totalsByCurrency({
            where: { id: zero.id, costObjectId: randomUUID() },
          }),
        ).toEqual({});
      }));
    async function withdrawalInput(activeId: string, requestId = randomUUID()) {
      await source.loadFromId();
      return {
        sourceExpenseId: source.id!,
        expectedActiveRevisionId: activeId,
        expectedSourceRevision: source.updated_at!,
        requestId,
        reviewEvidence: 'Withdraw synthetic attribution before correction',
      };
    }
    it('withdraws an unreserved allocation before correcting its original source without losing history', async () =>
      run(async () => {
        const allocation = await expenses.reviewAllocation(input, authority);
        await source.loadFromId();
        await expect(
          source.reopen({ reviewerProfileId: profileId }),
        ).rejects.toThrow();
        const request = await withdrawalInput(allocation.revision.id!);
        const withdrawn = await expenses.withdrawAllocation(request, authority);
        expect(withdrawn).toMatchObject({
          withdrawnRevisionId: allocation.revision.id,
          revision: {
            kind: 'withdrawal',
            previousRevisionId: allocation.revision.id,
          },
        });
        await source.loadFromId();
        expect(source.activeAllocationRevisionId).toBeNull();
        expect(source.reviewStatus).toBe('reviewed');
        expect(await expenses.totalsByCurrency()).toEqual({
          CAD: { amount: 100, count: 1 },
        });
        expect(
          await expenses.totalsByCurrency({
            where: { costObjectId: input.portions[0].costObjectId },
          }),
        ).toEqual({ CAD: { amount: 100, count: 1 } });
        expect(
          await expenses.totalsByCurrency({
            where: { costObjectId: input.portions[1].costObjectId },
          }),
        ).toEqual({});
        await source.reopen({ reviewerProfileId: profileId });
        source.amount = 200;
        source.incurredOn = '2026-11-03';
        source.paidBy = 'company';
        source.paidByProfileId = null;
        source.reimbursable = false;
        await source.save();
        expect(await expenses.totalsByCurrency()).toEqual({});
        const old = await resolveExpenseAllocationPortion(
          getDb(),
          allocation.portions[0].portionId,
          authority,
        );
        expect(old).toMatchObject({
          active: false,
          amountMinor: 60,
          incurredOn: '2026-11-01',
          paidBy: 'person',
          reimbursable: true,
        });
        expect(
          await getExpenseAllocationPortionPosition(
            getDb(),
            old.portionId,
            authority,
          ),
        ).toMatchObject({ available: false, identity: { active: false } });
        await source.review({ reviewerProfileId: profileId });
        const next = await expenses.reviewAllocation(
          {
            ...input,
            expectedSourceRevision: source.updated_at!,
            requestId: randomUUID(),
            portions: input.portions.map((part, i) => ({
              ...part,
              amountMinor: i ? 80 : 120,
            })),
          },
          authority,
        );
        expect(next.revision.previousRevisionId).toBe(withdrawn.revision.id);
        expect(next.revision.sourceFingerprint).not.toBe(
          allocation.revision.sourceFingerprint,
        );
        expect(next.portions[0]).toMatchObject({
          amountMinor: 120,
          incurredOn: '2026-11-03',
          paidBy: 'company',
          reimbursable: false,
          active: true,
        });
        expect(
          await resolveExpenseAllocationPortion(
            getDb(),
            old.portionId,
            authority,
          ),
        ).toEqual(old);
        expect(
          (await expenses.withdrawAllocation(request, authority)).revision.id,
        ).toBe(withdrawn.revision.id);
        await source.loadFromId();
        expect(source.activeAllocationRevisionId).toBe(next.revision.id);
        await expect(
          expenses.withdrawAllocation(
            { ...request, reviewEvidence: 'changed' },
            authority,
          ),
        ).rejects.toThrow('idempotency');
      }));
    it('permits explicit duplicate rejection after withdrawal while retaining bounded old provenance', async () =>
      run(async () => {
        const allocation = await expenses.reviewAllocation(input, authority);
        await expenses.withdrawAllocation(
          await withdrawalInput(allocation.revision.id!),
          authority,
        );
        await source.loadFromId();
        await source.markDuplicate({
          reviewerProfileId: profileId,
          duplicateOfId: input.portions[0].costObjectId,
        });
        expect(source.reviewStatus).toBe('rejected');
        expect(await expenses.totalsByCurrency()).toEqual({});
        expect(
          await resolveExpenseAllocationPortion(
            getDb(),
            allocation.portions[1].portionId,
            authority,
          ),
        ).toMatchObject({
          active: false,
          amountMinor: 40,
          incurredOn: '2026-11-01',
        });
      }));
    it('withdrawal serializes concurrent retries and rejects stale head/source or reused changed payload', async () =>
      run(async () => {
        const allocation = await expenses.reviewAllocation(input, authority);
        const request = await withdrawalInput(allocation.revision.id!);
        await expect(
          expenses.withdrawAllocation(
            { ...request, expectedActiveRevisionId: randomUUID() },
            authority,
          ),
        ).rejects.toThrow();
        await expect(
          expenses.withdrawAllocation(
            { ...request, expectedSourceRevision: '2020-01-01T00:00:00.000Z' },
            authority,
          ),
        ).rejects.toThrow('stale');
        const pair = await Promise.all([
          expenses.withdrawAllocation(request, authority),
          expenses.withdrawAllocation(request, authority),
        ]);
        expect(pair[0].revision.id).toBe(pair[1].revision.id);
        await expect(
          expenses.withdrawAllocation(
            { ...request, requestId: randomUUID() },
            authority,
          ),
        ).rejects.toThrow('stale');
        await expect(
          expenses.withdrawAllocation(
            { ...request, reviewEvidence: 'changed' },
            authority,
          ),
        ).rejects.toThrow('idempotency');
      }));
    it('withdrawal and competing reallocation admit one financial decision with exact totals', async () =>
      run(async () => {
        const allocation = await expenses.reviewAllocation(input, authority);
        const request = await withdrawalInput(allocation.revision.id!);
        const results = await Promise.allSettled([
          expenses.withdrawAllocation(request, authority),
          expenses.reviewAllocation(
            {
              ...input,
              expectedSourceRevision: request.expectedSourceRevision,
              requestId: randomUUID(),
              portions: input.portions.map((part) => ({
                ...part,
                amountMinor: 50,
              })),
            },
            authority,
          ),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        await source.loadFromId();
        expect(await expenses.totalsByCurrency()).toEqual({
          CAD: { amount: 100, count: 1 },
        });
        expect(
          await expenses.totalsByCurrency({
            where: { costObjectId: input.portions[0].costObjectId },
          }),
        ).toEqual({
          CAD: {
            amount: source.activeAllocationRevisionId ? 50 : 100,
            count: 1,
          },
        });
        expect(
          await expenses.totalsByCurrency({
            where: { costObjectId: input.portions[1].costObjectId },
          }),
        ).toEqual(
          source.activeAllocationRevisionId
            ? { CAD: { amount: 50, count: 1 } }
            : {},
        );
      }));
    it('withdrawal refuses a foreign restored original destination even if old portion targets remain valid', async () =>
      run(async () => {
        const foreign = await withTenant({ tenantId: randomUUID() }, () =>
          expenses.create({
            amount: 1,
            currency: 'CAD',
            incurredOn: '2026-11-01',
          }),
        );
        await source.reopen({ reviewerProfileId: profileId });
        source.costObjectId = foreign.id!;
        await source.save();
        await source.review({ reviewerProfileId: profileId });
        const allocation = await expenses.reviewAllocation(
          { ...input, expectedSourceRevision: source.updated_at! },
          authority,
        );
        await expect(
          expenses.withdrawAllocation(
            await withdrawalInput(allocation.revision.id!),
            authority,
          ),
        ).rejects.toThrow('active tenant');
        await source.loadFromId();
        expect(source.activeAllocationRevisionId).toBe(allocation.revision.id);
      }));
    it('withdrawal reauthorizes source, every old target and restored unsplit destination even on replay', async () =>
      run(async () => {
        const allocation = await expenses.reviewAllocation(input, authority);
        const request = await withdrawalInput(allocation.revision.id!);
        await expect(
          expenses.withdrawAllocation(request, {
            ...authority,
            authorizeUnsplitTarget: undefined,
          }),
        ).rejects.toThrow('unsplit');
        await expect(
          expenses.withdrawAllocation(request, {
            ...authority,
            async authorizeTarget(_actor, target) {
              if (target.portionKey === 'part-1')
                throw new Error('revoked-old-target');
            },
          }),
        ).rejects.toThrow('revoked-old-target');
        await expect(
          expenses.withdrawAllocation(request, {
            ...authority,
            async authorizeUnsplitTarget() {
              throw new Error('revoked-restored-target');
            },
          }),
        ).rejects.toThrow('revoked-restored-target');
        await expect(
          expenses.withdrawAllocation(request, {
            ...authority,
            async authorizeSource() {
              throw new Error('source-private');
            },
          }),
        ).rejects.toThrow('source-private');
        await expenses.withdrawAllocation(request, authority);
        await expect(
          expenses.withdrawAllocation(request, {
            ...authority,
            async authorizeUnsplitTarget() {
              throw new Error('revoked-restored-target');
            },
          }),
        ).rejects.toThrow('revoked-restored-target');
        await expect(
          withTenant(
            {
              tenantId: randomUUID(),
              userId,
              user: { id: userId, profileId },
              permissions: new Set(['expenses.recordReview']),
            },
            () => expenses.withdrawAllocation(request, authority),
          ),
        ).rejects.toThrow();
      }));
    it('withdrawal rolls back audit/head atomically after injected failure and caller rollback', async () =>
      run(async () => {
        const allocation = await expenses.reviewAllocation(input, authority);
        const request = await withdrawalInput(allocation.revision.id!);
        let inserted = false;
        GlobalInterceptors.register({
          name: 'allocation-failure',
          afterSave: async (object) => {
            if (
              object instanceof ExpenseAllocationRevision &&
              object.kind === 'withdrawal'
            ) {
              inserted = true;
              throw new Error('injected withdrawal');
            }
          },
        });
        await expect(
          expenses.withdrawAllocation(request, authority),
        ).rejects.toThrow();
        expect(inserted).toBe(true);
        GlobalInterceptors.unregister('allocation-failure');
        await source.loadFromId();
        expect(source.activeAllocationRevisionId).toBe(allocation.revision.id);
        expect(
          await expenses.totalsByCurrency({
            where: { costObjectId: input.portions[1].costObjectId },
          }),
        ).toEqual({ CAD: { amount: 40, count: 1 } });
        const transactional = getDb() as DatabaseInterface & {
          transaction<T>(
            work: (tx: DatabaseInterface) => Promise<T>,
          ): Promise<T>;
        };
        await expect(
          transactional.transaction(async (tx) => {
            await (
              await ExpenseCollection.create({ db: tx })
            ).withdrawAllocation(request, authority);
            throw new Error('caller rollback');
          }),
        ).rejects.toThrow('caller rollback');
        await source.loadFromId();
        expect(source.activeAllocationRevisionId).toBe(allocation.revision.id);
        expect(
          (await expenses.withdrawAllocation(request, authority)).revision.kind,
        ).toBe('withdrawal');
      }));
    it('withdrawal never releases reserved/bound/issued capacity and succeeds only after explicit draft abandonment', async () =>
      run(async () => {
        const allocation = await expenses.reviewAllocation(input, authority);
        const portionId = allocation.portions[0].portionId;
        const claim = await reserveExpenseAllocationPortion(
          getDb(),
          {
            portionId,
            requestId: randomUUID(),
            draftType: '@host/app:Draft',
            draftId: randomUUID(),
          },
          authority,
        );
        await expect(
          expenses.withdrawAllocation(
            await withdrawalInput(allocation.revision.id!),
            authority,
          ),
        ).rejects.toThrow('reserved');
        const { invoice, line } = await draft(portionId);
        await bindExpenseAllocationPortion(
          getDb(),
          claim.id!,
          {
            invoiceId: invoice.id!,
            invoiceLineId: line.id!,
            requestId: randomUUID(),
          },
          authority,
        );
        await expect(
          expenses.withdrawAllocation(
            await withdrawalInput(allocation.revision.id!),
            authority,
          ),
        ).rejects.toThrow('reserved');
        await releaseExpenseAllocationPortion(
          getDb(),
          claim.id!,
          randomUUID(),
          authority,
        );
        const withdrawn = await expenses.withdrawAllocation(
          await withdrawalInput(allocation.revision.id!),
          authority,
        );
        expect(withdrawn.revision.kind).toBe('withdrawal');
        await source.loadFromId();
        const next = await expenses.reviewAllocation(
          {
            ...input,
            requestId: randomUUID(),
            expectedSourceRevision: source.updated_at!,
          },
          authority,
        );
        const issued = await draft(next.portions[0].portionId);
        await reserveExpenseAllocationPortion(
          getDb(),
          {
            portionId: next.portions[0].portionId,
            requestId: randomUUID(),
            invoiceId: issued.invoice.id!,
            invoiceLineId: issued.line.id!,
          },
          authority,
        );
        await issued.invoice.loadFromId();
        issued.invoice.markSent();
        await issued.invoice.save();
        await expect(
          expenses.withdrawAllocation(
            await withdrawalInput(next.revision.id!),
            authority,
          ),
        ).rejects.toThrow('reserved');
      }));
    it('reviews 100 → 60/40 once, reloads canonical identities, and preserves source cash totals', async () =>
      run(async () => {
        const result = await expenses.reviewAllocation(input, authority);
        expect(calls).toEqual(input.portions.map((row) => row.costObjectId));
        const bounded = await resolveExpenseAllocationPortion(
          getDb(),
          result.portions[0].portionId,
          {
            ...authority,
            async authorizeSource() {
              throw new Error('originals-private');
            },
          },
        );
        expect(bounded).toMatchObject({
          amountMinor: 60,
          incurredOn: '2026-11-01',
          paidBy: 'person',
          reimbursable: true,
          hasRefunds: false,
          costBasisMinor: null,
          hasSupplierTax: null,
        });
        expect(bounded).not.toHaveProperty('sourceAmount');
        expect(bounded).not.toHaveProperty('receipts');
        expect(bounded).not.toHaveProperty('sourceFingerprintNonce');
        const readOnly = await run(
          () =>
            resolveExpenseAllocationPortion(
              getDb(),
              result.portions[0].portionId,
              authority,
            ),
          ['expenses.read'],
        );
        expect(readOnly.portionId).toBe(result.portions[0].portionId);
        await expect(
          run(
            () =>
              reserveExpenseAllocationPortion(
                getDb(),
                {
                  portionId: readOnly.portionId,
                  requestId: randomUUID(),
                  draftType: '@host/app:Draft',
                  draftId: randomUUID(),
                },
                authority,
              ),
            ['expenses.read'],
          ),
        ).rejects.toThrow();
        expect(result.portions.map((row) => row.amountMinor)).toEqual([60, 40]);
        expect(
          result.portions.every(
            (row) =>
              row.active &&
              row.sourceExpenseId === source.id &&
              row.sourceFingerprint.length === 64,
          ),
        ).toBe(true);
        const replay = await expenses.reviewAllocation(input, authority);
        expect(replay.portions.map((row) => row.portionId)).toEqual(
          result.portions.map((row) => row.portionId),
        );
        expect(
          await resolveExpenseAllocationPortion(
            getDb(),
            result.portions[0].portionId,
            authority,
          ),
        ).toEqual(result.portions[0]);
        expect(await expenses.totalsByCurrency()).toEqual({
          CAD: { amount: 100, count: 1 },
        });
        for (const portion of input.portions)
          expect(
            await expenses.totalsByCurrency({
              where: {
                costObjectType: portion.costObjectType,
                costObjectId: portion.costObjectId,
              },
            }),
          ).toEqual({ CAD: { amount: portion.amountMinor, count: 1 } });
        expect(await expenses.reimbursementPosition(source.id!)).toMatchObject({
          sourceAmount: 100,
          remainingAmount: 100,
        });
        const loaded = (await expenses.get(
          { id: source.id },
          { cache: false },
        ))!;
        await loaded.markReimbursed({
          amount: 100,
          reference: 'synthetic-only',
        });
        expect(await expenses.reimbursementPosition(source.id!)).toMatchObject({
          reimbursedAmount: 100,
          remainingAmount: 0,
        });
      }));
    it('rejects malformed amounts, duplicate keys, unknown fields, unknown targets and wrong totals atomically', async () =>
      run(async () => {
        const variants = [
          [{ ...input.portions[0], amountMinor: 0 }, input.portions[1]],
          [{ ...input.portions[0], amountMinor: 60.5 }, input.portions[1]],
          [
            { ...input.portions[0], amountMinor: Number.MAX_SAFE_INTEGER + 1 },
            input.portions[1],
          ],
          [
            input.portions[0],
            { ...input.portions[1], portionKey: input.portions[0].portionKey },
          ],
          [{ ...input.portions[0], surprise: 1 }, input.portions[1]],
          [
            {
              ...input.portions[0],
              costObjectType: '@unknown/package:Missing',
            },
            input.portions[1],
          ],
          [
            { ...input.portions[0], costObjectId: randomUUID() },
            input.portions[1],
          ],
          [{ ...input.portions[0], amountMinor: 59 }, input.portions[1]],
        ];
        for (const portions of variants)
          await expect(
            expenses.reviewAllocation({ ...input, portions }, authority),
          ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
        expect(
          (await expenses.get({ id: source.id }, { cache: false }))
            ?.activeAllocationRevisionId,
        ).toBeNull();
      }));
    it('requires current ambient reviewer and mandatory authority for every target, including replay', async () => {
      await expect(
        run(() => expenses.reviewAllocation(input, authority), []),
      ).rejects.toThrow();
      await expect(
        run(() =>
          expenses.reviewAllocation(
            input,
            {} as ExpenseAllocationBillingAuthority,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        run(() =>
          expenses.reviewAllocation(input, {
            ...authority,
            async authorizeTarget(_principal, target) {
              if (target.portionKey === 'part-1') throw new Error('revoked');
            },
          }),
        ),
      ).rejects.toThrow('revoked');
      await expect(
        run(() =>
          expenses.reviewAllocation(input, {
            ...authority,
            async authorizeSource() {
              throw new Error('source-private');
            },
          }),
        ),
      ).rejects.toThrow('source-private');
      await run(() => expenses.reviewAllocation(input, authority));
      await expect(
        run(() =>
          expenses.reviewAllocation(input, {
            ...authority,
            async authorizeTarget() {
              throw new Error('revoked');
            },
          }),
        ),
      ).rejects.toThrow('revoked');
      const savedTenant = tenantId;
      tenantId = randomUUID();
      await expect(
        run(() => expenses.reviewAllocation(input, authority)),
      ).rejects.toThrow();
      tenantId = savedTenant;
    });
    it('conflicts on changed idempotency payload and stale source; concurrent identical calls share one result', async () =>
      run(async () => {
        const pair = await Promise.all([
          expenses.reviewAllocation(input, authority),
          expenses.reviewAllocation(input, authority),
        ]);
        expect(pair[0].revision.id).toBe(pair[1].revision.id);
        await expect(
          expenses.reviewAllocation(
            { ...input, reviewEvidence: 'changed' },
            authority,
          ),
        ).rejects.toThrow('idempotency');
        await expect(
          expenses.reviewAllocation(
            { ...input, requestId: randomUUID() },
            authority,
          ),
        ).rejects.toThrow('stale');
      }));
    it('rolls back first child, all reservations and head on failure, and honors caller rollback', async () =>
      run(async () => {
        let saves = 0;
        GlobalInterceptors.register({
          name: 'allocation-failure',
          afterSave: async (object) => {
            if (object instanceof ExpenseAllocationPortion && ++saves === 1)
              throw new Error('injected after first portion');
          },
        });
        await expect(
          expenses.reviewAllocation(input, authority),
        ).rejects.toThrow('Operation failed');
        expect(saves).toBe(1);
        GlobalInterceptors.unregister('allocation-failure');
        expect(
          (await expenses.get({ id: source.id }, { cache: false }))
            ?.activeAllocationRevisionId,
        ).toBeNull();
        const transactional = getDb() as DatabaseInterface & {
          transaction<T>(
            work: (tx: DatabaseInterface) => Promise<T>,
          ): Promise<T>;
        };
        await expect(
          transactional.transaction(async (tx) => {
            await reviewExpenseAllocation(tx, input, authority);
            throw new Error('caller rollback');
          }),
        ).rejects.toThrow('caller rollback');
        expect(
          (await expenses.get({ id: source.id }, { cache: false }))
            ?.activeAllocationRevisionId,
        ).toBeNull();
        expect(
          (await expenses.reviewAllocation(input, authority)).portions,
        ).toHaveLength(2);
      }));
    it('supersedes unbilled revisions without changing history and refuses direct evidence/source rewrites', async () =>
      run(async () => {
        const original = await expenses.reviewAllocation(input, authority);
        const loaded = (await expenses.get(
          { id: source.id },
          { cache: false },
        ))!;
        const next = await expenses.reviewAllocation(
          {
            ...input,
            expectedSourceRevision: loaded.updated_at!,
            requestId: randomUUID(),
            portions: input.portions.map((row, i) => ({
              ...row,
              amountMinor: i ? 30 : 70,
            })),
          },
          authority,
        );
        expect(next.revision.previousRevisionId).toBe(original.revision.id);
        expect(next.revision.sourceFingerprint).toBe(
          original.revision.sourceFingerprint,
        );
        expect(
          await resolveExpenseAllocationPortion(
            getDb(),
            original.portions[0].portionId,
            authority,
          ),
        ).toMatchObject({ amountMinor: 60, active: false });
        await expect(original.revision.save()).rejects.toThrow('immutable');
        await expect(original.revision.delete()).rejects.toThrow();
        await loaded.loadFromId();
        await expect(
          loaded.reopen({ reviewerProfileId: profileId }),
        ).rejects.toThrow('Allocated');
        await loaded.loadFromId();
        loaded.activeAllocationRevisionId = null;
        await expect(loaded.save()).rejects.toThrow('command-owned');
        await expect(loaded.delete()).rejects.toThrow('Allocated');
        const fresh = new ExpenseAllocationRevision({
          ...original.revision.toJSON(),
          db: getDb(),
        });
        await fresh.initialize();
        await expect(fresh.save()).rejects.toThrow();
        expect(
          isApiActionEnabledForObject(
            ObjectRegistry.getEffectiveClassByConstructor(
              ExpenseAllocationPortion,
            )?.qualifiedName ??
              '@happyvertical/smrt-expenses:ExpenseAllocationPortion',
            'create',
          ),
        ).toBe(false);
      }));
  });
}
