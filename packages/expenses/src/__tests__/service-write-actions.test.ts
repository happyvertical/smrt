/**
 * #4001: the service-backed expense actions on the generated REST route.
 *
 * `record`, `attachReceipt`, `recordReview` and `recordReimbursement` are
 * hosted on ExpenseCollection, delegate to the guarded Expense flow, and
 * authorize the ambient principal themselves (`expenses.<action>`), so the
 * runtime REST transport — whose auth middleware only sees the HTTP verb —
 * cannot become an unguarded write. Generated CRUD stays refused, reads stay
 * closed, and MCP/CLI publish nothing (#4004 adds per-operation MCP
 * authorization).
 */
import { randomUUID } from 'node:crypto';
import { AssetCollection } from '@happyvertical/smrt-assets';
import {
  getTestDatabase,
  isApiActionEnabledForObject,
  MCPGenerator,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  type TenantContextData,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExpenseCollection } from '../collections/ExpenseCollection.js';
import { ExpenseReceiptCollection } from '../collections/ExpenseReceiptCollection.js';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const RECORDER = { userId: randomUUID(), profileId: randomUUID() };
const REVIEWER = { userId: randomUUID(), profileId: randomUUID() };
const EXPENSE_KEY = '@happyvertical/smrt-expenses:Expense';
const P = (action: string) => `expenses.${action}`;
const SHA = 'a'.repeat(64);
const BODY = {
  costObjectType: '@happyvertical/smrt-projects:Project',
  costObjectId: 'project-1',
  category: 'material',
  description: 'Lumber',
  amount: 10000,
  currency: 'USD',
  incurredOn: '2026-09-15',
};

function principal(
  who: { userId: string; profileId: string },
  permissions: string[],
  tenantId = TENANT_A,
): TenantContextData {
  return {
    tenantId,
    userId: who.userId,
    user: { id: who.userId, profileId: who.profileId },
    permissions: new Set(permissions),
  };
}

describe('service-backed expense actions (#4001)', () => {
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const api = new APIGenerator(
      {
        basePath: '/api',
        // Host authentication passes; authorization is the action's job.
        authMiddleware: () => async (req: Request) => req,
      },
      { db },
    );
    api.registerCollection('expenses', await ExpenseCollection.create({ db }));
    handler = api.generateHandler();
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  const call = (
    context: TenantContextData,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    withTenant(context, async () => {
      const response = await handler(
        new Request(`http://localhost/api/expenses${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    });

  const recorder = (
    permissions = [P('record'), P('attachReceipt')],
    tenantId = TENANT_A,
  ) => principal(RECORDER, permissions, tenantId);
  const reviewer = (
    permissions = [P('recordReview'), P('recordReimbursement')],
  ) => principal(REVIEWER, permissions);

  async function recordOne(extra: Record<string, unknown> = {}) {
    const recorded = await call(recorder(), 'POST', '/record', {
      ...BODY,
      ...extra,
    });
    expect(recorded.status).toBe(200);
    return recorded.body.result.id as string;
  }

  async function asset(tenantId = TENANT_A): Promise<string> {
    return withTenant({ tenantId }, async () => {
      const assets = await AssetCollection.create({ db });
      const created = await assets.create({
        name: 'receipt.pdf',
        mimeType: 'application/pdf',
        sourceUri: `file:///receipts/${randomUUID()}.pdf`,
      });
      await created.save();
      return created.id as string;
    });
  }

  it('records, attaches a receipt, reviews and reimburses through the Expense flow', async () => {
    const recorded = await call(recorder(), 'POST', '/record', {
      ...BODY,
      paidBy: 'person',
      reimbursable: true,
      // Caller-supplied tenant, recorder and review state are never honoured.
      tenantId: TENANT_B,
      recordedByProfileId: REVIEWER.profileId,
      reviewStatus: 'reviewed',
      reimbursedAt: '2026-09-20T00:00:00Z',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.result).toMatchObject({
      tenantId: TENANT_A,
      recordedByProfileId: RECORDER.profileId,
      paidBy: 'person',
      paidByProfileId: RECORDER.profileId,
      reviewStatus: 'unreviewed',
      reimbursedAt: null,
    });
    expect(recorded.body.result.recordedAt).toBeTruthy();
    const expenseId = recorded.body.result.id as string;

    const assetId = await asset();
    const attached = await call(recorder(), 'POST', '/attachReceipt', {
      expenseId,
      assetId,
      contentSha256: SHA,
      uploadedByProfileId: REVIEWER.profileId,
    });
    expect(attached.status).toBe(200);
    expect(attached.body.result).toMatchObject({
      expenseId,
      assetId,
      contentSha256: SHA,
      uploadedByProfileId: RECORDER.profileId,
      tenantId: TENANT_A,
    });
    const again = await call(recorder(), 'POST', '/attachReceipt', {
      expenseId,
      assetId,
      contentSha256: SHA,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'EXPENSE_RECEIPT_DUPLICATE',
    });

    const reviewed = await call(reviewer(), 'POST', '/recordReview', {
      expenseId,
      decision: 'approve',
      note: 'Matches the PO',
      reviewerProfileId: RECORDER.profileId,
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.result).toMatchObject({
      reviewStatus: 'reviewed',
      reviewedByProfileId: REVIEWER.profileId,
      reviewNote: 'Matches the PO',
    });
    expect(reviewed.body.result.reviewedAt).toBeTruthy();

    const partial = await call(reviewer(), 'POST', '/recordReimbursement', {
      expenseId,
      amount: BODY.amount - 1,
      reference: 'must-not-record-partial',
    });
    expect(partial.status).toBe(400);

    const reimbursed = await call(reviewer(), 'POST', '/recordReimbursement', {
      expenseId,
      reference: 'payroll-2026-09',
    });
    expect(reimbursed.status).toBe(200);
    expect(reimbursed.body.result).toMatchObject({
      reviewStatus: 'reviewed',
      reimbursementReference: 'payroll-2026-09',
      reimbursedAmount: BODY.amount,
    });
    expect(reimbursed.body.result.reimbursedAt).toBeTruthy();
  });

  it('refuses invalid financial facts before writing any row', async () => {
    const refused = await call(recorder(), 'POST', '/record', {
      ...BODY,
      financialBreakdown: { version: 1, subtotal: 1, currency: 'USD' },
    });
    expect(refused.status).toBe(400);
    expect(
      (
        await call(recorder(), 'POST', '/record', {
          ...BODY,
          financialBreakdown: 'not-an-object',
        })
      ).status,
    ).toBe(400);
    await withTenant({ tenantId: TENANT_A }, async () => {
      const expenses = await ExpenseCollection.create({ db });
      expect(await expenses.list({})).toEqual([]);
    });
  });

  it('rejects with a reason, and refuses a reasonless rejection', async () => {
    const expenseId = await recordOne();
    const reasonless = await call(reviewer(), 'POST', '/recordReview', {
      expenseId,
      decision: 'reject',
    });
    expect(reasonless.status).toBe(400);
    expect(reasonless.body.error).toMatchObject({ code: 'EXPENSE_INVALID' });
    const rejected = await call(reviewer(), 'POST', '/recordReview', {
      expenseId,
      decision: 'reject',
      reason: 'Personal purchase',
    });
    expect(rejected.body.result).toMatchObject({
      reviewStatus: 'rejected',
      reviewedByProfileId: REVIEWER.profileId,
      reviewNote: 'Personal purchase',
    });
    const twice = await call(reviewer(), 'POST', '/recordReview', {
      expenseId,
      decision: 'approve',
    });
    expect(twice.status).toBe(409);
  });

  it('refuses each action without its permission', async () => {
    expect(
      (await call(recorder([P('attachReceipt')]), 'POST', '/record', BODY))
        .status,
    ).toBe(403);
    const expenseId = await recordOne({ reimbursable: true, paidBy: 'person' });
    expect(
      (
        await call(recorder([P('record')]), 'POST', '/attachReceipt', {
          expenseId,
          assetId: await asset(),
          contentSha256: SHA,
        })
      ).status,
    ).toBe(403);
    // The recorder cannot review or reimburse their own expense without the grants.
    expect(
      (
        await call(recorder(), 'POST', '/recordReview', {
          expenseId,
          decision: 'approve',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(recorder(), 'POST', '/recordReimbursement', {
          expenseId,
        })
      ).status,
    ).toBe(403);
  });

  it('does not let super-admin bypass stand in for review or reimbursement grants', async () => {
    const expenseId = await recordOne({ reimbursable: true, paidBy: 'person' });
    for (const [path, body] of [
      ['/recordReview', { expenseId, decision: 'approve' }],
      ['/recordReimbursement', { expenseId }],
    ] as const) {
      const response = await call(
        { ...principal(REVIEWER, []), superAdminBypass: true },
        'POST',
        path,
        body,
      );
      expect(response.status, path).toBe(403);
    }
  });

  it("guards other people's expenses and other tenants", async () => {
    const expenseId = await recordOne();
    const other = principal({ userId: randomUUID(), profileId: randomUUID() }, [
      P('record'),
      P('attachReceipt'),
    ]);
    expect(
      (
        await call(other, 'POST', '/attachReceipt', {
          expenseId,
          assetId: await asset(),
          contentSha256: SHA,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(other, 'POST', '/record', {
          ...BODY,
          paidBy: 'person',
          paidByProfileId: RECORDER.profileId,
        })
      ).status,
    ).toBe(403);
    const foreign = principal(
      REVIEWER,
      [P('recordReview'), P('recordReimbursement')],
      TENANT_B,
    );
    expect(
      (
        await call(foreign, 'POST', '/recordReview', {
          expenseId,
          decision: 'approve',
        })
      ).status,
    ).toBe(404);
  });

  it('fails closed without an authenticated tenant principal', async () => {
    const response = await handler(
      new Request('http://localhost/api/expenses/record', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(BODY),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('keeps generated CRUD and reads refused on REST, and the receipts table unwritten', async () => {
    const expenseId = await recordOne();
    const everything = recorder([
      P('record'),
      P('create'),
      P('update'),
      P('read'),
    ]);
    expect((await call(everything, 'POST', '', BODY)).status).toBe(405);
    expect((await call(everything, 'GET', '')).status).toBe(405);
    expect((await call(everything, 'GET', `/${expenseId}`)).status).toBe(405);
    expect(
      (
        await call(everything, 'PATCH', `/${expenseId}`, {
          reviewStatus: 'reviewed',
        })
      ).status,
    ).toBe(405);
    for (const action of [
      'list',
      'get',
      'create',
      'update',
      'delete',
    ] as const) {
      expect(isApiActionEnabledForObject(EXPENSE_KEY, action), action).toBe(
        false,
      );
    }
    await withTenant({ tenantId: TENANT_A }, async () => {
      const receipts = await ExpenseReceiptCollection.create({ db });
      expect(await receipts.receiptsFor(expenseId)).toEqual([]);
    });
  });

  it('publishes no expense tool on MCP', async () => {
    const tools = (await new MCPGenerator().generateTools()).map(
      (tool) => tool.name,
    );
    expect(tools.filter((name) => /^expense/.test(name))).toEqual([]);
  });
});
