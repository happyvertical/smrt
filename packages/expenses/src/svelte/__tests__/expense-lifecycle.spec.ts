import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import {
  ExpenseForm,
  ExpenseList,
  ExpenseReceiptCapture,
  ExpenseReviewQueue,
} from '../index.js';
import type { ExpenseListItem } from '../types.js';

const row: ExpenseListItem = {
  id: 'expense-a',
  description: 'Materials',
  amount: 12500,
  currency: 'CAD',
  incurredOn: '2026-10-05',
  statusLabel: 'Future status',
  costObjectType: '@example/jobs:Job',
  costObjectId: 'job-a',
};
describe('Expense lifecycle presentation', () => {
  it('registers lifecycle surfaces', () => {
    for (const [slot, component] of [
      ['expense-list', ExpenseList],
      ['expense-receipt-capture', ExpenseReceiptCapture],
      ['expense-review-queue', ExpenseReviewQueue],
    ] as const) {
      expect(ModuleUIRegistry.get('@happyvertical/smrt-expenses', slot)).toBe(
        component,
      );
    }
  });
  it('retains editable cost object text, mapped names and server errors', () => {
    const body = render(ExpenseForm, {
      props: {
        action: '',
        values: {
          amount: 'bad',
          currency: 'CAD',
          incurredOn: '',
          description: '',
          category: '',
          vendorId: '',
          commitmentId: '',
          paidBy: 'company',
          paidByProfileId: '',
          correctionReason: '',
        },
        costObject: { type: 'unknown-class', id: 'unknown-id' },
        costObjectFields: { type: 'objectType', id: 'objectId' },
        costObjectErrors: { id: 'Not visible' },
      },
    }).body;
    expect(body).toContain('name="objectType"');
    expect(body).toContain('value="unknown-class"');
    expect(body).toContain('name="objectId"');
    expect(body).toContain('value="unknown-id"');
    expect(body).toContain('Not visible');
    expect(body).toContain('value="bad"');
    expect(body).toContain('inputmode="decimal"');
  });
  it('filters by both exact cost-object keys without merging currencies or losing unknown statuses', () => {
    const body = render(ExpenseList, {
      props: {
        expenses: [
          row,
          {
            ...row,
            id: 'expense-b',
            description: 'Other class',
            costObjectType: '@other:Job',
          },
          {
            ...row,
            id: 'expense-c',
            description: 'Other id',
            costObjectId: 'job-b',
          },
          {
            ...row,
            id: 'expense-d',
            description: 'JPY purchase',
            amount: 123,
            currency: 'JPY',
            href: '/authorized/expense-d',
          },
        ],
        costObjectType: row.costObjectType,
        costObjectId: row.costObjectId,
        message: 'Refresh failed',
      },
    }).body;
    expect(body).toContain('125.00');
    expect(body).toContain('JPY purchase');
    expect(body).not.toContain('Other class');
    expect(body).not.toContain('Other id');
    expect(body).toContain('Future status');
    expect(body).toContain('Refresh failed');
    expect(body).toContain('href="/authorized/expense-d"');
    expect(
      render(ExpenseList, {
        props: { expenses: [row], costObjectType: '', costObjectId: '' },
      }).body,
    ).toContain('No expenses for this cost object');
  });
  it('posts receipt files natively with caller-owned tokens and no implicit authority', () => {
    const props = {
      action: '/attach',
      canAttach: true,
      fileField: 'document',
      hiddenFields: [
        { name: 'requestId', value: 'unchanged' },
        { name: 'expenseId', value: row.id },
      ],
      message: 'Upload rejected',
    };
    const body = render(ExpenseReceiptCapture, { props }).body;
    expect(body).toContain('enctype="multipart/form-data"');
    expect(body).toContain('type="file"');
    expect(body).toContain('name="document"');
    expect(body).toContain('value="unchanged"');
    expect(body).toContain('value="attach-receipt"');
    expect(body).toContain('Upload rejected');
    expect(body).toContain('select the file again');
    expect(
      render(ExpenseReceiptCapture, { props: { ...props, canAttach: false } })
        .body,
    ).not.toContain('<form');
    expect(
      render(ExpenseReceiptCapture, { props: { ...props, pending: true } })
        .body,
    ).toMatch(/<button[^>]*disabled/);
  });
  it('preserves per-row reasons and identity and explicit action/capability gates', () => {
    const props = {
      canReview: true,
      expenses: [
        {
          ...row,
          canReview: true,
          action: '',
          reason: 'Bad receipt',
          message: 'Denied',
          hiddenFields: [{ name: 'requestId', value: 'review-key' }],
        },
      ],
      expenseField: 'id',
      reasonField: 'reviewReason',
      intentField: 'decision',
    };
    const body = render(ExpenseReviewQueue, { props }).body;
    expect(body).toContain('action=""');
    expect(body).toContain('name="id"');
    expect(body).toContain('value="expense-a"');
    expect(body).toContain('name="reviewReason"');
    expect(body).toContain('Bad receipt');
    expect(body).toContain('required');
    expect(body).toContain('name="decision" value="approve"');
    expect(body).toContain('formnovalidate');
    expect(body).toContain('name="decision" value="reject"');
    expect(body).toContain('value="review-key"');
    expect(body).toContain('Denied');
    for (const overrides of [{ canReview: false }, { action: undefined }]) {
      expect(
        render(ExpenseReviewQueue, {
          props: {
            ...props,
            expenses: [{ ...props.expenses[0], ...overrides }],
          },
        }).body,
      ).not.toContain('<form');
    }
    expect(
      render(ExpenseReviewQueue, { props: { ...props, canReview: false } })
        .body,
    ).not.toContain('<form');
    expect(
      render(ExpenseReviewQueue, { props: { expenses: [] } }).body,
    ).toContain('No expenses awaiting review');
  });
});
