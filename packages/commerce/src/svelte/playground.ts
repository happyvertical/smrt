import { COMMERCE_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleInvoice = {
  id: 'invoice-2026-0142',
  invoiceNumber: 'INV-2026-0142',
  status: 'sent',
  issueDate: '2026-03-15T00:00:00.000Z',
  dueDate: '2026-03-29T00:00:00.000Z',
  totalAmount: 128450,
  customerName: 'Riverstone Newsroom',
  projectName: 'Editorial Systems Retainer',
};

const sampleUnbilledItems = [
  {
    id: 'unbilled-time-1',
    type: 'time',
    description: 'Governance workflow setup',
    date: '2026-03-12T00:00:00.000Z',
    amount: 42000,
    category: 'Implementation',
    selected: true,
  },
  {
    id: 'unbilled-expense-1',
    type: 'expense',
    description: 'Contributor QA workshop',
    date: '2026-03-14T00:00:00.000Z',
    amount: 18500,
    category: 'Training',
  },
  {
    id: 'unbilled-time-2',
    type: 'time',
    description: 'Release validation and docs cleanup',
    date: '2026-03-18T00:00:00.000Z',
    amount: 33950,
    category: 'QA',
  },
];

const loadInvoiceActions = () => import('./components/InvoiceActions.svelte');
const loadInvoiceCard = () => import('./components/InvoiceCard.svelte');
const loadUnbilledItems = () => import('./components/UnbilledItems.svelte');

export default {
  packageName: '@happyvertical/smrt-commerce',
  displayName: COMMERCE_MODULE_META.displayName,
  description: COMMERCE_MODULE_META.description,
  moduleMeta: COMMERCE_MODULE_META,
  entries: [
    {
      id: 'invoice-card',
      title: 'Invoice Card',
      description:
        'Compact invoice summary card used in billing and receivables views.',
      loadComponent: loadInvoiceCard,
      order: 1,
      props: {
        invoice: sampleInvoice,
        currency: 'CAD',
        onclick: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'invoice-actions',
      title: 'Invoice Actions',
      description:
        'Status-aware billing actions for sending, printing, exporting, and payment confirmation.',
      loadComponent: loadInvoiceActions,
      order: 2,
      props: {
        status: 'sent',
        onmarkpaid: noop,
        onprint: noop,
        onexport: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'unbilled-items',
      title: 'Unbilled Items',
      description:
        'Selectable unbilled work list for creating a new invoice from accumulated items.',
      loadComponent: loadUnbilledItems,
      order: 3,
      props: {
        items: sampleUnbilledItems,
        currency: 'CAD',
        onselectionchange: noop,
        oncreate: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
