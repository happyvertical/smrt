import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/** Discoverable presentation slots owned by Expenses. */
export const EXPENSES_UI_SLOTS: Record<string, ModuleUISlot> = {
  'expense-list': {
    id: 'expense-list',
    label: 'Expense List',
    description: 'Authorized expenses per cost object',
    icon: 'file-text',
    category: 'list',
    order: 3,
    propsInterface: 'ExpenseListProps',
  },
  'expense-receipt-capture': {
    id: 'expense-receipt-capture',
    label: 'Receipt Capture',
    description: 'Camera and native multipart receipt attachment',
    icon: 'file-text',
    category: 'form',
    order: 4,
    propsInterface: 'ExpenseReceiptCaptureProps',
  },
  'expense-review-queue': {
    id: 'expense-review-queue',
    label: 'Expense Review Queue',
    description: 'Native approve and reject with retained reason',
    icon: 'file-text',
    category: 'list',
    order: 5,
    propsInterface: 'ExpenseReviewQueueProps',
  },
  'expense-form': {
    id: 'expense-form',
    label: 'Expense Entry',
    description: 'Native retained-value purchase and expense entry',
    icon: 'file-text',
    category: 'form',
    order: 1,
    propsInterface: 'ExpenseFormProps',
  },
  'expense-review': {
    id: 'expense-review',
    label: 'Expense Review',
    description: 'Duplicate/correction review and private receipt composition',
    icon: 'file-text',
    category: 'detail',
    order: 2,
    propsInterface: 'ExpenseReviewPanelProps',
  },
};
/** Module metadata consumed without importing Svelte components. */
export const EXPENSES_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-expenses',
  displayName: 'Expenses',
  description: 'Expense entry, receipt and duplicate review',
  uiSlots: EXPENSES_UI_SLOTS,
  models: ['Expense', 'ExpenseReceipt'],
  collections: ['ExpenseCollection', 'ExpenseReceiptCollection'],
};
