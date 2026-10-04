import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { ExpenseForm, ExpenseReviewPanel } from '../index.js';
import type { ExpenseDraftValues, ExpenseFormProps } from '../types.js';

const values: ExpenseDraftValues = {
  amount: '125.00',
  currency: 'CAD',
  incurredOn: '2026-10-03',
  description: 'Supplier materials',
  category: 'materials',
  vendorId: 'vendor-a',
  commitmentId: 'contract-a',
  paidBy: 'company',
  paidByProfileId: '',
  correctionReason: '',
};
const form = (props: Partial<ExpenseFormProps> = {}) =>
  render(ExpenseForm, { props: { action: '/save', values, ...props } }).body;

describe('Expenses native UI contracts', () => {
  it('registers public package surfaces', () => {
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-expenses', 'expense-form'),
    ).toBe(ExpenseForm);
    expect(
      ModuleUIRegistry.get('@happyvertical/smrt-expenses', 'expense-review'),
    ).toBe(ExpenseReviewPanel);
  });
  it('preserves ordinary currency text, native names, retained Commerce references and caller tokens', () => {
    const body = form({
      fields: { amount: 'purchaseAmount' },
      intentField: 'operation',
      intent: 'correct',
      hiddenFields: [
        { name: 'requestId', value: 'caller-key' },
        { name: 'context', value: 'a' },
        { name: 'context', value: 'b' },
      ],
    });
    expect(body).toContain('method="post"');
    expect(body).toContain('name="purchaseAmount"');
    expect(body).toContain('value="125.00"');
    expect(body).toMatch(
      /<select[^>]+name="currency"[^>]*>[\s\S]*?<option value="CAD" selected/,
    );
    expect(body).toContain('value="vendor-a" selected');
    expect(body).toContain('value="contract-a" selected');
    expect(body).toContain('name="operation" value="correct"');
    expect(body).toContain('value="caller-key"');
    expect(body.match(/name="context"/g)).toHaveLength(2);
  });
  it('preserves an unknown retained currency and its mapped native name', () => {
    const body = form({
      values: { ...values, currency: 'ZZZ' },
      fields: { currency: 'expenseCurrency' },
      currencyOptions: [{ value: 'CAD', label: 'Canadian dollar only' }],
    });
    expect(body).toMatch(
      /<select[^>]+name="expenseCurrency"[^>]*>[\s\S]*?<option value="ZZZ" selected/,
    );
    expect(body).toContain('Canadian dollar only');
  });
  it('retains malformed dates/amounts and correction errors without model coercion', () => {
    const body = form({
      values: {
        ...values,
        amount: '12.bad',
        incurredOn: 'not-a-date',
        paidBy: 'future-payer',
        correctionReason: 'Retain reason',
      },
      correcting: true,
      errors: { amount: 'Bad amount', correctionReason: 'Reason rejected' },
      message: 'Denied',
      retryStatus: 'transport-error',
    });
    expect(body).toContain('value="12.bad"');
    expect(body).toContain('value="not-a-date"');
    expect(body).toContain('value="future-payer" selected');
    expect(body).toContain('Retain reason');
    expect(body).toContain('Bad amount');
    expect(body).toContain('Reason rejected');
    expect(body).toContain('aria-invalid="true"');
    expect(body).toContain('Denied');
    expect(body).toContain('The outcome is uncertain');
  });
  it('enforces presentation read-only/pending without resetting values', () => {
    const body = form({ canEdit: false });
    expect(body).toContain('<fieldset disabled');
    expect(body).not.toContain('value="save"');
    expect(body).toContain('value="125.00"');
    expect(form({ retryStatus: 'submitting' })).toMatch(/<button[^>]*disabled/);
  });
  it('renders integer minor amounts, caller status/duplicates/history and Assets receipts without automatic actions', () => {
    const body = render(ExpenseReviewPanel, {
      props: {
        expense: {
          description: 'Materials',
          amount: 12500,
          currency: 'CAD',
          incurredOn: '2026-10-03',
          statusLabel: 'Future review state',
        },
        duplicates: [
          {
            id: 'expense-b',
            label: 'Matching expense',
            reason: 'Matching receipt fingerprint',
          },
        ],
        history: [
          {
            id: 'event',
            label: 'Correction retained',
            detail: 'Caller actor/time',
          },
        ],
        receipts: {
          attachments: [
            {
              id: 'receipt',
              name: 'Private receipt.pdf',
              mimeType: 'application/pdf',
              viewHref: '/authorized/receipt',
            },
          ],
        },
        canReview: false,
        action: '/review',
        actions: [{ intent: 'approve', label: 'Review now' }],
      },
    }).body;
    expect(body).toContain('125.00');
    expect(body).toContain('Future review state');
    expect(body).toContain('Matching receipt fingerprint');
    expect(body).toContain('Correction retained');
    expect(body).toContain('Private receipt.pdf');
    expect(body).toContain('href="/authorized/receipt"');
    expect(body).not.toContain('value="approve"');
  });
  it('supports same-page review while preserving explicit capability, endpoint and action gates', () => {
    const props = {
      expense: {
        description: 'Materials',
        amount: 0,
        currency: 'CAD',
        incurredOn: '',
        statusLabel: 'Unreviewed',
      },
      canReview: true,
      action: '',
      actions: [{ intent: 'approve', label: 'Approve expense' }],
      hiddenFields: [{ name: 'requestId', value: 'same-review' }],
    };
    const body = render(ExpenseReviewPanel, { props }).body;
    expect(body).toContain('action=""');
    expect(body).toContain('method="post"');
    expect(body).toContain('name="intent" value="approve"');
    expect(body).toContain('value="same-review"');
    for (const overrides of [
      { action: undefined },
      { canReview: false },
      { actions: [] },
    ]) {
      expect(
        render(ExpenseReviewPanel, { props: { ...props, ...overrides } }).body,
      ).not.toContain('<form');
    }
    expect(
      render(ExpenseReviewPanel, { props: { ...props, pending: true } }).body,
    ).toMatch(/<button[^>]*disabled/);
    expect(
      render(ExpenseReviewPanel, {
        props: { ...props, actions: [{ ...props.actions[0], disabled: true }] },
      }).body,
    ).toMatch(/<button[^>]*disabled/);
  });
  it('only renders caller-supplied review actions with exact request identity', () => {
    const body = render(ExpenseReviewPanel, {
      props: {
        expense: {
          description: 'Materials',
          amount: 0,
          currency: 'CAD',
          incurredOn: '',
          statusLabel: 'Unreviewed',
        },
        canReview: true,
        action: '/review',
        actions: [{ intent: 'mark-duplicate', label: 'Mark duplicate' }],
        hiddenFields: [{ name: 'fingerprint', value: 'same-review' }],
        message: 'Approval invalidated',
      },
    }).body;
    expect(body).toContain('No possible duplicates supplied');
    expect(body).toContain('No history supplied');
    expect(body).toContain('action="/review"');
    expect(body).toContain('name="intent" value="mark-duplicate"');
    expect(body).toContain('value="same-review"');
    expect(body).toContain('Approval invalidated');
  });
  it('renders a caller-selected subset without inventing or duplicating fixed payer values', () => {
    const body = form({
      visibleFields: ['amount', 'currency', 'description'],
      fields: { amount: 'purchaseAmount' },
      hiddenFields: [
        { name: 'paidBy', value: 'company' },
        { name: 'requestId', value: 'retained' },
      ],
      values: { ...values, amount: '12.bad', currency: 'ZZZ' },
      errors: { amount: 'Bad amount' },
    });
    expect(body).toContain('name="purchaseAmount"');
    expect(body).toContain('value="12.bad"');
    expect(body).toContain('Bad amount');
    expect(body).toContain('value="ZZZ" selected');
    expect(body.match(/name="paidBy"/g)).toHaveLength(1);
    expect(body).toContain('value="company"');
    expect(body).toContain('value="retained"');
    for (const name of [
      'paidByProfileId',
      'vendorId',
      'commitmentId',
      'incurredOn',
      'category',
      'correctionReason',
    ])
      expect(body).not.toContain(`name="${name}"`);
  });
  it('honors empty subsets and correction visibility without changing readonly or retry controls', () => {
    const empty = form({ visibleFields: [], correcting: true });
    for (const name of Object.keys(values))
      expect(empty).not.toContain(`name="${name}"`);
    expect(empty).toContain('method="post"');
    const correction = form({
      visibleFields: ['correctionReason'],
      correcting: true,
      values: { ...values, correctionReason: 'Retained reason' },
      canEdit: false,
    });
    expect(correction).toContain('Retained reason');
    expect(correction).toContain('<fieldset disabled');
    expect(correction).not.toContain('value="save"');
    expect(
      form({ visibleFields: ['amount'], retryStatus: 'submitting' }),
    ).toMatch(/<button[^>]*disabled/);
  });
});
