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
    expect(body).toContain('value="vendor-a" selected');
    expect(body).toContain('value="contract-a" selected');
    expect(body).toContain('name="operation" value="correct"');
    expect(body).toContain('value="caller-key"');
    expect(body.match(/name="context"/g)).toHaveLength(2);
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
});
