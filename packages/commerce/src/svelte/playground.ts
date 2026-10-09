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

const sampleCustomer = {
  id: 'customer-riverstone',
  profileId: 'profile-riverstone',
  profile: {
    id: 'profile-riverstone',
    name: 'Riverstone Newsroom',
    email: 'accounts@riverstone.example',
    description: 'Independent newsroom and publishing customer.',
    identityKind: 'business',
  },
  status: 'active',
  customerType: 'wholesale',
  creditLimitMinor: 250000,
  paymentTerms: 'Net 30',
  taxExempt: false,
  defaultShippingAddress: {
    street1: '88 River Avenue',
    city: 'Edmonton',
    state: 'AB',
    postalCode: 'T5J 0K1',
    country: 'Canada',
  },
  contacts: [
    {
      id: 'contact-avery',
      name: 'Avery Chen',
      label: 'Accounts payable',
      email: 'avery@riverstone.example',
      phone: '+1 780 555 0142',
    },
  ],
};

const sampleVendor = {
  id: 'vendor-northstar',
  profileId: 'profile-northstar',
  profile: {
    id: 'profile-northstar',
    name: 'Northstar Supply',
    email: 'orders@northstar.example',
    description: 'Regional materials and equipment supplier.',
    identityKind: 'business',
  },
  status: 'active',
  leadTimeDays: 7,
  minimumOrderMinor: 50000,
  paymentTerms: 'Net 45',
  currency: 'CAD',
  defaultContactEmail: 'orders@northstar.example',
  defaultContactPhone: '+1 403 555 0188',
  contacts: [
    {
      id: 'contact-morgan',
      name: 'Morgan Lee',
      label: 'Order desk',
      email: 'morgan@northstar.example',
      phone: '+1 403 555 0117',
    },
  ],
};

const loadCustomerDirectory = () =>
  import('./components/CustomerDirectory.svelte');
const loadCustomerDetail = () => import('./components/CustomerDetail.svelte');
const loadPartySelectPreview = () =>
  import('./playground/PartySelectPreview.svelte');
const loadPartyFormPreview = () =>
  import('./playground/PartyFormPreview.svelte');
const loadInvoiceActions = () => import('./components/InvoiceActions.svelte');
const loadInvoiceCard = () => import('./components/InvoiceCard.svelte');
const loadUnbilledItems = () => import('./components/UnbilledItems.svelte');
const loadVendorDirectory = () => import('./components/VendorDirectory.svelte');
const loadVendorDetail = () => import('./components/VendorDetail.svelte');

export default {
  packageName: '@happyvertical/smrt-commerce',
  displayName: COMMERCE_MODULE_META.displayName,
  description: COMMERCE_MODULE_META.description,
  moduleMeta: COMMERCE_MODULE_META,
  entries: [
    {
      id: 'purchase-order-editor',
      title: 'Purchase and award preparation',
      description:
        'Native allocation entry, review and retained uncertain-response recovery.',
      loadComponent: () => import('./components/PurchasingPlayground.svelte'),
      order: 30,
      props: { reduction: false },
      modes: { mock: { label: 'Interactive demo' } },
    },
    {
      id: 'purchase-reduction',
      title: 'Explicit allocation reduction',
      description:
        'Every retained allocation remains present; zero is explicit, never inferred from blank.',
      loadComponent: () => import('./components/PurchasingPlayground.svelte'),
      order: 31,
      props: { reduction: true },
      modes: { mock: { label: 'Interactive demo' } },
    },

    {
      id: 'quote-editor',
      title: 'Vendor quotation editor',
      description:
        'Edit, add/remove rows and recover a simulated rejected native submission.',
      loadComponent: () => import('./components/QuotePlayground.svelte'),
      order: 20,
      props: { kind: 'vendor-quotation' },
      modes: { mock: { label: 'Interactive demo' } },
    },
    {
      id: 'customer-estimate-editor',
      title: 'Customer estimate editor',
      description:
        'Customer estimate draft and retained revision comparison, without acceptance or budget writes.',
      loadComponent: () => import('./components/QuotePlayground.svelte'),
      order: 21,
      props: { kind: 'customer-estimate' },
      modes: { mock: { label: 'Interactive demo' } },
    },

    {
      id: 'pricing-version-decision',
      title: 'Pricing version decisions',
      description:
        'Compare retained estimates and rehearse a rejected decision without losing input.',
      loadComponent: () => import('./playground/PricingVersionPreview.svelte'),
      order: 30,
      props: {},
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'customer-directory',
      title: 'Customer Directory',
      description:
        'Search, paging, responsive cards, and consumer-owned links.',
      loadComponent: loadCustomerDirectory,
      order: 1,
      props: {
        items: [{ data: sampleCustomer, href: '#customer-detail' }],
        total: 26,
        page: 1,
        pageSize: 25,
        nextHref: '#customer-page-2',
        addHref: '#add-customer',
        canCreate: true,
      },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'customer-detail',
      title: 'Customer Detail',
      description:
        'Profile identity, commercial terms, addresses, and contacts.',
      loadComponent: loadCustomerDetail,
      order: 2,
      props: {
        customer: sampleCustomer,
        currency: 'CAD',
        backHref: '#customers',
        editHref: '#edit-customer',
        canEdit: true,
      },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'customer-form',
      title: 'Customer Form',
      description:
        'Native create/edit submission with retained values and contacts.',
      loadComponent: loadPartyFormPreview,
      order: 3,
      props: { kind: 'customer' },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'vendor-directory',
      title: 'Vendor Directory',
      description:
        'Search, paging, empty/error states, and consumer-owned links.',
      loadComponent: loadVendorDirectory,
      order: 4,
      props: {
        items: [{ data: sampleVendor, href: '#vendor-detail' }],
        total: 1,
        addHref: '#add-vendor',
        canCreate: true,
      },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'vendor-detail',
      title: 'Vendor Detail',
      description:
        'Profile identity, purchasing terms, and contact composition.',
      loadComponent: loadVendorDetail,
      order: 5,
      props: {
        vendor: sampleVendor,
        backHref: '#vendors',
        editHref: '#edit-vendor',
        canEdit: true,
      },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'vendor-form',
      title: 'Vendor Form',
      description:
        'Native create/edit submission with retained currency text and contacts.',
      loadComponent: loadPartyFormPreview,
      order: 6,
      props: { kind: 'vendor' },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'customer-select',
      title: 'Customer Select',
      description:
        'Searchable customer picker with status and type, resolving the current value and offering a new-customer action.',
      loadComponent: loadPartySelectPreview,
      order: 10,
      props: { kind: 'customer' },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'vendor-select',
      title: 'Vendor Select',
      description:
        'Searchable vendor picker with status; the caller supplies the lookup.',
      loadComponent: loadPartySelectPreview,
      order: 11,
      props: { kind: 'vendor' },
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'invoice-preparation',
      title: 'Invoice Preparation',
      description:
        'Edit invoice lines, prices, discounts and tax, with optional source allocations and retained rejection recovery.',
      loadComponent: () =>
        import('./playground/InvoicePreparationPreview.svelte'),
      order: 7,
      props: {},
      modes: { mock: { label: 'Mock' } },
    },
    {
      id: 'invoice-card',
      title: 'Invoice Card',
      description:
        'Compact invoice summary card used in billing and receivables views.',
      loadComponent: loadInvoiceCard,
      order: 20,
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
      order: 21,
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
      order: 22,
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
