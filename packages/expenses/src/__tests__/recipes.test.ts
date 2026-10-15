import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFieldRefs } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { Expense } from '../models/Expense.js';
import { ExpenseReceipt } from '../models/ExpenseReceipt.js';
import { ExpensesRecipe } from '../recipes.js';

describe('expenses recipes (#3590)', () => {
  it('declares the expenses recipe over its own models', () => {
    expect(ExpensesRecipe.id).toBe('expenses.tracking');
    // Receipts come along as a child model with no nav entry of their own.
    expect(ExpensesRecipe.models).toEqual([Expense, ExpenseReceipt]);
    expect(
      ExpensesRecipe.nav.map((entry) => [entry.label, entry.model]),
    ).toEqual([['Expenses', Expense]]);
    expect(ExpensesRecipe.requires).toEqual([]);
    expect(ExpensesRecipe.section?.id).toBe('accounting');
    expect(ExpensesRecipe.nav[0].icon).toBeTruthy();
  });

  it('hides the cost-object and commitment plumbing', () => {
    const fields = ExpensesRecipe.options.Expense.fields;
    for (const name of [
      'costObjectType',
      'commitmentId',
      'commitmentLineId',
      'financialBreakdown',
    ] as const) {
      expect(fields[name].visibility).toBe('hidden');
    }
    expect(fields.description.required).toBe(true);
    // save() requires the payer's profile when a person paid.
    expect(fields.paidByProfileId).not.toHaveProperty('visibility');
    const expense = new Expense();
    for (const name of Object.keys(fields)) {
      expect(name in expense, name).toBe(true);
    }
    const receipt = new ExpenseReceipt();
    for (const name of Object.keys(
      ExpensesRecipe.options.ExpenseReceipt.fields,
    )) {
      expect(name in receipt, name).toBe(true);
    }
  });

  describe('user-facing help (#3591)', () => {
    const markdown = () =>
      readFileSync(
        fileURLToPath(new URL(`../${ExpensesRecipe.help}`, import.meta.url)),
        'utf-8',
      );

    it('points at a help file beside recipes.ts', () => {
      expect(ExpensesRecipe.help).toMatch(/^\.\/[a-z-]+\.recipe\.md$/);
      expect(markdown()).toContain('## Overview');
      expect(markdown()).toContain('## Tasks');
    });

    it('names only fields the model declares', () => {
      const expense = new Expense();
      const refs = extractFieldRefs(markdown());
      expect(refs).toEqual(
        expect.arrayContaining(['amount', 'incurredOn', 'reviewStatus']),
      );
      for (const ref of refs) expect(ref in expense, ref).toBe(true);
    });
  });
});
