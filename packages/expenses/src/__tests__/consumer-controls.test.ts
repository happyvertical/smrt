/**
 * The two controls both consumers (teamworks-os, domacraft.com) need, because
 * they gate cost visibility by permission (`purchasing.view_costs`,
 * `finance.costs.read`):
 *
 *  1. No generated read or write reaches expenses or receipts: the models ship
 *     with `api: { include: [] }`, `mcp: { include: [] }`, `cli: false`, so a
 *     consumer exposes them only through its own permission-checked routes.
 *  2. Tenant scoping a consumer can make required: a qualified
 *     `registerTenantScopedClass(…, { mode: 'required' })` overrides the
 *     package's optional default, and reads without a tenant context fail.
 */

import { randomUUID } from 'node:crypto';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  registerTenantScopedClass,
  TenantContextError,
  unregisterTenantScopedClass,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExpenseCollection } from '../collections/ExpenseCollection.js';
import { ExpenseReceiptCollection } from '../collections/ExpenseReceiptCollection.js';
import { Expense } from '../models/Expense.js';
import { ExpenseReceipt } from '../models/ExpenseReceipt.js';
import { createWorld } from './helpers/expense-suite.js';

const EXPENSE = '@happyvertical/smrt-expenses:Expense';
const RECEIPT = '@happyvertical/smrt-expenses:ExpenseReceipt';
const COLLECTIONS = [
  '@happyvertical/smrt-expenses:ExpenseCollection',
  '@happyvertical/smrt-expenses:ExpenseReceiptCollection',
];

describe('consumer controls', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('registers both models under their package-qualified names', () => {
    expect(ObjectRegistry.getClassByConstructor(Expense)?.qualifiedName).toBe(
      EXPENSE,
    );
    expect(
      ObjectRegistry.getClassByConstructor(ExpenseReceipt)?.qualifiedName,
    ).toBe(RECEIPT);
  });

  describe('generated surface is closed', () => {
    it('declares no API, MCP, or CLI operation', () => {
      for (const name of [EXPENSE, RECEIPT, ...COLLECTIONS]) {
        const config = ObjectRegistry.getConfig(name);
        expect(config.api).toEqual({ include: [] });
        expect(config.mcp).toEqual({ include: [] });
        expect(config.cli).toBe(false);
      }
    });

    it('generates no MCP tool for expenses or receipts', async () => {
      const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
      const tools = await generator.generateTools();
      const leaked = tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('expense'));
      expect(leaked).toEqual([]);
    });

    it('answers every generated REST read and write with 405, even when authenticated', async () => {
      const world = await createWorld(db);
      const expense = await world.expense();
      const api = new APIGenerator({
        basePath: '/api/v1',
        // Authenticated caller: the refusal must come from the closed
        // surface, not from a missing session.
        authMiddleware: () => async (req) => req,
      });
      api.registerCollection('expenses', world.expenses);
      api.registerCollection('expense-receipts', world.receipts);
      const handler = api.generateHandler();
      const json = { 'content-type': 'application/json' };

      const requests: Array<[string, RequestInit]> = [
        ['expenses', { method: 'GET' }],
        [`expenses/${expense.id}`, { method: 'GET' }],
        [
          'expenses',
          {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ amount: 1, currency: 'USD' }),
          },
        ],
        [
          `expenses/${expense.id}`,
          {
            method: 'PUT',
            headers: json,
            body: JSON.stringify({ reviewStatus: 'reviewed' }),
          },
        ],
        [`expenses/${expense.id}`, { method: 'DELETE' }],
        ['expense-receipts', { method: 'GET' }],
      ];
      for (const [path, init] of requests) {
        const response = await handler(
          new Request(`http://local/api/v1/${path}`, init),
        );
        expect(
          response.status,
          `${init.method} ${path} must not be served`,
        ).toBe(405);
      }

      const review = await handler(
        new Request(`http://local/api/v1/expenses/${expense.id}/review`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ reviewerProfileId: randomUUID() }),
        }),
      );
      expect(review.status).toBeGreaterThanOrEqual(400);
      expect(review.status).not.toBe(401);

      const unchanged = await world.expenses.get({ id: expense.id });
      expect(unchanged?.reviewStatus).toBe('unreviewed');
      expect(unchanged?.amount).toBe(10000);
    });
  });

  describe('tenant scoping a consumer can make required', () => {
    afterEach(() => {
      unregisterTenantScopedClass(EXPENSE);
      unregisterTenantScopedClass(RECEIPT);
    });

    it('is optional by default: a trusted call without context reads', async () => {
      enableTenancy();
      const expenses = await ExpenseCollection.create({ db });
      await expect(expenses.list({})).resolves.toEqual([]);
    });

    it('fails closed without a tenant once the consumer requires it', async () => {
      registerTenantScopedClass(EXPENSE, { mode: 'required' });
      registerTenantScopedClass(RECEIPT, { mode: 'required' });
      enableTenancy();

      const world = await createWorld(db);
      const expense = await world.inTenant(() => world.expense());

      const expenses = await ExpenseCollection.create({ db });
      const receipts = await ExpenseReceiptCollection.create({ db });
      await expect(expenses.list({})).rejects.toBeInstanceOf(
        TenantContextError,
      );
      await expect(receipts.list({})).rejects.toBeInstanceOf(
        TenantContextError,
      );
      await expect(
        expenses
          .create({
            amount: 100,
            currency: 'USD',
            incurredOn: '2026-09-01',
          })
          .then((draft) => draft.save()),
      ).rejects.toBeInstanceOf(TenantContextError);

      const visible = await withTenant({ tenantId: world.tenantId }, () =>
        expenses.list({}),
      );
      expect(visible.map((row) => row.id)).toEqual([expense.id]);
      const otherTenant = await withTenant({ tenantId: randomUUID() }, () =>
        expenses.list({}),
      );
      expect(otherTenant).toEqual([]);
    });
  });
});
