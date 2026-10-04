import { EXPENSES_MODULE_META } from '../ui.js';
export default {
  packageName: '@happyvertical/smrt-expenses',
  displayName: 'Expenses',
  description: 'Purchase entry, receipts and duplicate review',
  moduleMeta: EXPENSES_MODULE_META,
  entries: [
    {
      id: 'expense-workflow',
      title: 'Expense Workflow',
      description:
        'Native purchase entry with rejected-value retention and receipt review.',
      loadComponent: () => import('./playground/ExpenseWorkflowPreview.svelte'),
      order: 1,
      props: {},
      modes: { mock: { label: 'Mock' } },
    },
  ],
};
