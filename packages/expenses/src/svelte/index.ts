/** Package-owned Expenses components and native presentation contracts. */
import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { EXPENSES_MODULE_META } from '../ui.js';
import ExpenseForm from './components/ExpenseForm.svelte';
import ExpenseList from './components/ExpenseList.svelte';
import ExpenseReceiptCapture from './components/ExpenseReceiptCapture.svelte';
import ExpenseReviewPanel from './components/ExpenseReviewPanel.svelte';
import ExpenseReviewQueue from './components/ExpenseReviewQueue.svelte';

export type {
  ExpenseDraftValues,
  ExpenseDuplicateCandidate,
  ExpenseFormProps,
  ExpenseHistoryEntry,
  ExpenseListItem,
  ExpenseListProps,
  ExpenseReceiptCaptureProps,
  ExpenseReferenceOption,
  ExpenseRequestField,
  ExpenseReviewAction,
  ExpenseReviewPanelProps,
  ExpenseReviewQueueItem,
  ExpenseReviewQueueProps,
  ExpenseReviewSummary,
} from './types.js';
export {
  ExpenseForm,
  ExpenseList,
  ExpenseReceiptCapture,
  ExpenseReviewPanel,
  ExpenseReviewQueue,
};

ModuleUIRegistry.registerModule(EXPENSES_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-expenses',
  'expense-form',
  ExpenseForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-expenses',
  'expense-review',
  ExpenseReviewPanel,
);

ModuleUIRegistry.register(
  '@happyvertical/smrt-expenses',
  'expense-list',
  ExpenseList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-expenses',
  'expense-receipt-capture',
  ExpenseReceiptCapture,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-expenses',
  'expense-review-queue',
  ExpenseReviewQueue,
);
