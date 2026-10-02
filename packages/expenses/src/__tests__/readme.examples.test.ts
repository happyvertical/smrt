/**
 * README parity: the Usage, duplicates, and money examples, run as written.
 * (The required-tenancy example is covered by consumer-controls.test.ts.)
 */

import { randomUUID } from 'node:crypto';
import { AssetCollection } from '@happyvertical/smrt-assets';
import { ContractCollection } from '@happyvertical/smrt-commerce';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeContentSha256,
  DuplicateReceiptError,
  ExpenseCollection,
  ExpenseReceiptCollection,
} from '../index.js';

describe('README examples', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('records, attaches, reviews, and draws down a commitment', async () => {
    const tenantId = randomUUID();
    const recorder = { id: randomUUID() };
    const manager = { id: randomUUID() };
    const project = { id: 'project-42' };
    const fileBytes = new TextEncoder().encode('%PDF-1.7 lumber receipt');

    await withTenant({ tenantId }, async () => {
      const purchaseOrder = await (await ContractCollection.create({ db }))
        .create({
          _meta_type: 'PurchaseOrder',
          totalAmount: 460000,
          currency: 'USD',
        } as never)
        .then(async (po) => po.save());
      const asset = await (await AssetCollection.create({ db }))
        .create({ name: 'lumber.pdf', mimeType: 'application/pdf' })
        .then(async (a) => a.save());

      const expenses = await ExpenseCollection.create({ db });
      const expense = await expenses.create({
        costObjectType: '@happyvertical/smrt-projects:Project',
        costObjectId: project.id,
        category: 'material',
        description: 'Framing lumber',
        amount: 100000,
        currency: 'USD',
        incurredOn: '2026-09-15',
        recordedByProfileId: recorder.id,
        commitmentId: purchaseOrder.id,
      });
      await expense.save();

      const receipts = await ExpenseReceiptCollection.create({ db });
      await receipts.attachReceipt({
        expenseId: String(expense.id),
        assetId: String(asset.id),
        contentSha256: computeContentSha256(fileBytes),
        byteCount: fileBytes.byteLength,
        uploadedByProfileId: recorder.id,
      });

      await expense.review({ reviewerProfileId: manager.id });

      const position = await expenses.commitmentPosition(
        String(purchaseOrder.id),
      );
      expect(position).toMatchObject({ drawn: 100000, open: 360000 });

      // Same file, same expense → DuplicateReceiptError.
      await expect(
        receipts.attachReceipt({
          expenseId: String(expense.id),
          assetId: String(asset.id),
          contentSha256: computeContentSha256(fileBytes),
        }),
      ).rejects.toBeInstanceOf(DuplicateReceiptError);

      // Same file, different expenses → allowed and listed.
      const second = await expenses.create({
        costObjectType: '@happyvertical/smrt-projects:Project',
        costObjectId: project.id,
        amount: 4000,
        currency: 'CAD',
        incurredOn: '2026-09-16',
      });
      await second.save();
      await receipts.attachReceipt({
        expenseId: String(second.id),
        assetId: String(asset.id),
        contentSha256: computeContentSha256(fileBytes),
      });
      const groups = await receipts.findDuplicateReceipts();
      expect(groups[0]?.expenseIds).toEqual(
        [String(expense.id), String(second.id)].sort(),
      );

      await second.review({ reviewerProfileId: manager.id });
      expect(
        await expenses.totalsByCurrency({
          where: { costObjectId: project.id },
        }),
      ).toEqual({
        USD: { amount: 100000, count: 1 },
        CAD: { amount: 4000, count: 1 },
      });
    });
  });
});
