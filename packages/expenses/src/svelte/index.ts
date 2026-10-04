/** Package-owned Expenses components and native presentation contracts. */
import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { EXPENSES_MODULE_META } from '../ui.js';
import ExpenseForm from './components/ExpenseForm.svelte';
import ExpenseReviewPanel from './components/ExpenseReviewPanel.svelte';

export type {
  ExpenseDraftValues,
  ExpenseDuplicateCandidate,
  ExpenseFormProps,
  ExpenseHistoryEntry,
  ExpenseReferenceOption,
  ExpenseRequestField,
  ExpenseReviewAction,
  ExpenseReviewPanelProps,
  ExpenseReviewSummary,
} from './types.js';
export { ExpenseForm, ExpenseReviewPanel };

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
