/**
 * Declared recipes for smrt-commerce (#3590, #3604): user-facing units of
 * functionality an app, agent or planner can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import {
  Agreement,
  Contract,
  Estimate,
  Lease,
  LicenseSale,
  Order,
  PurchaseOrder,
  WholesaleOrder,
} from './models/Contract.js';
import { ContractLineItem } from './models/ContractLineItem.js';
import { Customer } from './models/Customer.js';
import { Fulfillment } from './models/Fulfillment.js';
import { FulfillmentLineItem } from './models/FulfillmentLineItem.js';
import { Invoice } from './models/Invoice.js';
import { InvoiceLineItem } from './models/InvoiceLineItem.js';
import { Payment } from './models/Payment.js';
import { PaymentAllocation } from './models/PaymentAllocation.js';
import { Vendor } from './models/Vendor.js';

/** Customers: Keep a list of the people and companies you sell to. */
export class CustomersRecipe extends SmrtRecipe {
  static id = 'commerce.customers';
  static help = './customers.recipe.md';
  static label = 'Customers';
  static summary = 'Keep a list of the people and companies you sell to.';
  static synonyms = ['clients', 'buyers', 'accounts'];
  static section = {
    id: 'sales',
    label: 'Sales',
    icon: 'shoppingBag',
    description: 'Customers, orders and quotes: everything you sell.',
  };
  static models = [Customer];
  static nav = [
    {
      label: 'Customers',
      model: Customer,
      icon: 'users',
      description:
        'The people and companies you sell to, with how to reach them.',
    },
  ];
  static options = {
    Customer: { fields: { profileId: { label: 'Name', order: -1 } } },
  } as const;
}

/** Purchases: Order from your vendors and track what you have bought. */
export class PurchasesRecipe extends SmrtRecipe {
  static id = 'commerce.purchases';
  static help = './purchases.recipe.md';
  static label = 'Purchases';
  static summary = 'Order from your vendors and track what you have bought.';
  static synonyms = ['purchase orders', 'buying', 'procurement'];
  static section = {
    id: 'purchasing',
    label: 'Purchasing',
    icon: 'truck',
    description: 'Vendors and purchase orders: everything you buy.',
  };
  static models = [PurchaseOrder, ContractLineItem];
  static nav = [
    {
      label: 'Purchase orders',
      model: PurchaseOrder,
      icon: 'truck',
      description:
        'What you have ordered from your suppliers and when it arrives.',
    },
  ];
  static requires = ['commerce.vendors'];
  static options = {
    PurchaseOrder: {
      fields: {
        contractType: {
          default: 'purchase_order',
          visibility: 'hidden',
          locked: true,
        },
        customerId: { visibility: 'hidden', locked: true },
        vendorId: { label: 'Vendor', order: 1 },
        channelId: { visibility: 'hidden' },
        expiryDate: { visibility: 'hidden' },
      },
    },
    ContractLineItem: {
      fields: {
        sku: { visibility: 'hidden' },
        startDate: { visibility: 'hidden' },
        endDate: { visibility: 'hidden' },
        billingPeriod: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
  } as const;
}

/** Sales: Take customer orders and track them. */
export class SalesRecipe extends SmrtRecipe {
  static id = 'commerce.sales';
  static help = './sales.recipe.md';
  static label = 'Sales';
  static summary = 'Take customer orders and track them.';
  static synonyms = ['sales orders', 'orders', 'customer orders'];
  static section = {
    id: 'sales',
    label: 'Sales',
    icon: 'shoppingBag',
    description: 'Customers, orders and quotes: everything you sell.',
  };
  static models = [Order, ContractLineItem];
  static nav = [
    {
      label: 'Sales orders',
      model: Order,
      icon: 'shoppingBag',
      description: 'Orders from your customers, from placed to delivered.',
    },
  ];
  static requires = ['commerce.customers'];
  static options = {
    Order: {
      fields: {
        contractType: { default: 'order', visibility: 'hidden', locked: true },
        vendorId: { visibility: 'hidden', locked: true },
        customerId: { label: 'Customer', order: 1, required: true },
        channelId: { visibility: 'hidden' },
        expiryDate: { visibility: 'hidden' },
      },
    },
    ContractLineItem: {
      fields: {
        sku: { visibility: 'hidden' },
        startDate: { visibility: 'hidden' },
        endDate: { visibility: 'hidden' },
        billingPeriod: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
  } as const;
}

/** Vendors: Keep a list of the suppliers you buy from. */
export class VendorsRecipe extends SmrtRecipe {
  static id = 'commerce.vendors';
  static help = './vendors.recipe.md';
  static label = 'Vendors';
  static summary = 'Keep a list of the suppliers you buy from.';
  static synonyms = ['suppliers', 'sellers'];
  static section = {
    id: 'purchasing',
    label: 'Purchasing',
    icon: 'truck',
    description: 'Vendors and purchase orders: everything you buy.',
  };
  static models = [Vendor];
  static nav = [
    {
      label: 'Vendors',
      model: Vendor,
      icon: 'briefcase',
      description: 'The suppliers you buy from, with terms and contacts.',
    },
  ];
  static options = {
    Vendor: { fields: { profileId: { label: 'Name', order: -1 } } },
  } as const;
}

/** Estimates: Send customers a price quote before they commit. */
export class EstimatesRecipe extends SmrtRecipe {
  static id = 'commerce.estimates';
  static help = './estimates.recipe.md';
  static label = 'Estimates';
  static summary = 'Send customers a price quote before they commit.';
  static synonyms = ['quotes', 'quotations', 'proposals', 'bids'];
  static section = {
    id: 'sales',
    label: 'Sales',
    icon: 'shoppingBag',
    description: 'Customers, orders and quotes: everything you sell.',
  };
  static models = [Estimate, ContractLineItem];
  static nav = [
    {
      label: 'Estimates',
      model: Estimate,
      icon: 'fileText',
      description:
        'Quotes you have sent, ready to turn into orders when accepted.',
    },
  ];
  static requires = ['commerce.customers'];
  static options = {
    Estimate: {
      fields: {
        contractType: {
          default: 'estimate',
          visibility: 'hidden',
          locked: true,
        },
        vendorId: { visibility: 'hidden', locked: true },
        customerId: { label: 'Customer', order: 1, required: true },
        channelId: { visibility: 'hidden' },
      },
    },
    ContractLineItem: {
      fields: {
        sku: { visibility: 'hidden' },
        startDate: { visibility: 'hidden' },
        endDate: { visibility: 'hidden' },
        billingPeriod: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
  } as const;
}

/** Wholesale orders: Take bulk orders from trade customers. */
export class WholesaleRecipe extends SmrtRecipe {
  static id = 'commerce.wholesale';
  static help = './wholesale.recipe.md';
  static label = 'Wholesale orders';
  static summary = 'Take bulk orders from trade customers.';
  static synonyms = ['bulk orders', 'trade orders', 'b2b'];
  static section = {
    id: 'sales',
    label: 'Sales',
    icon: 'shoppingBag',
    description: 'Customers, orders and quotes: everything you sell.',
  };
  static models = [WholesaleOrder, ContractLineItem];
  static nav = [
    {
      label: 'Wholesale orders',
      model: WholesaleOrder,
      icon: 'shoppingBag',
      description: 'Bulk orders from cafes, shops and other businesses.',
    },
  ];
  static requires = ['commerce.customers'];
  static options = {
    WholesaleOrder: {
      fields: {
        contractType: {
          default: 'wholesale_order',
          visibility: 'hidden',
          locked: true,
        },
        vendorId: { visibility: 'hidden', locked: true },
        customerId: { label: 'Customer', order: 1 },
        channelId: { visibility: 'hidden' },
        expiryDate: { visibility: 'hidden' },
      },
    },
    ContractLineItem: {
      fields: {
        sku: { visibility: 'hidden' },
        startDate: { visibility: 'hidden' },
        endDate: { visibility: 'hidden' },
        billingPeriod: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
  } as const;
}

/** Invoicing: Bill customers and record the payments that come in. */
export class InvoicingRecipe extends SmrtRecipe {
  static id = 'commerce.invoicing';
  static help = './invoicing.recipe.md';
  static label = 'Invoicing';
  static summary = 'Bill customers and record the payments that come in.';
  static synonyms = ['invoices', 'billing', 'payments', 'receivables'];
  static group = {
    id: 'billing',
    label: 'Billing & shipping',
    summary:
      'Invoice your customers, record what they pay and ship what they ordered.',
  };
  static section = {
    id: 'billing',
    label: 'Billing',
    icon: 'receipt',
    description: 'Invoices and the payments against them.',
  };
  static models = [Invoice, InvoiceLineItem, Payment, PaymentAllocation];
  static nav = [
    {
      label: 'Invoices',
      model: Invoice,
      icon: 'receipt',
      description:
        'Bills you have sent and which ones are still waiting to be paid.',
    },
    {
      label: 'Payments',
      model: Payment,
      icon: 'creditCard',
      description: 'Money received, matched to the invoices it paid.',
    },
  ];
  static requires = ['commerce.customers'];
  static options = {
    Invoice: {
      fields: {
        providerTaxAmount: { visibility: 'hidden' },
        arJournalId: { visibility: 'hidden' },
        revenueJournalId: { visibility: 'hidden' },
        externalId: { visibility: 'hidden' },
        customerExternalId: { visibility: 'hidden' },
        externalProvider: { visibility: 'hidden' },
        syncedAt: { visibility: 'hidden' },
        collectionMethod: { visibility: 'hidden' },
        sentAt: { visibility: 'hidden' },
        viewedAt: { visibility: 'hidden' },
        remindersSent: { visibility: 'hidden' },
        lastReminderAt: { visibility: 'hidden' },
        reference: { visibility: 'hidden' },
        customerId: { required: true },
      },
    },
    InvoiceLineItem: {
      fields: {
        invoiceEditorStateJson: { visibility: 'hidden' },
        sourceType: { visibility: 'hidden' },
        sourceId: { visibility: 'hidden' },
        periodStart: { visibility: 'hidden' },
        periodEnd: { visibility: 'hidden' },
        revenueAccountId: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        sku: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
    Payment: {
      fields: {
        journalId: { visibility: 'hidden' },
        externalId: { visibility: 'hidden' },
        externalProvider: { visibility: 'hidden' },
        syncedAt: { visibility: 'hidden' },
        backendId: { visibility: 'hidden' },
        backendTxRef: { visibility: 'hidden' },
        nativeAmount: { visibility: 'hidden' },
        nativeCurrency: { visibility: 'hidden' },
        usdAtQuote: { visibility: 'hidden' },
        usdAtConfirmation: { visibility: 'hidden' },
        transactionId: { visibility: 'hidden' },
      },
    },
    PaymentAllocation: { fields: { allocatedBy: { visibility: 'hidden' } } },
  } as const;
}

/** Shipping: Pack, ship and deliver orders, with tracking. */
export class FulfillmentRecipe extends SmrtRecipe {
  static id = 'commerce.fulfillment';
  static help = './fulfillment.recipe.md';
  static label = 'Shipping';
  static summary = 'Pack, ship and deliver orders, with tracking.';
  static synonyms = ['fulfillment', 'delivery', 'shipments', 'tracking'];
  static group = {
    id: 'billing',
    label: 'Billing & shipping',
    summary:
      'Invoice your customers, record what they pay and ship what they ordered.',
  };
  static section = {
    id: 'operations',
    label: 'Operations',
    icon: 'wrench',
    description: 'Fulfillment and the day-to-day work behind an order.',
  };
  static models = [Fulfillment, FulfillmentLineItem];
  static nav = [
    {
      label: 'Shipments',
      model: Fulfillment,
      icon: 'truck',
      description: 'What has gone out the door and where it is now.',
    },
  ];
  static requiresAny = [['commerce.sales', 'commerce.wholesale']];
  static options = {
    Fulfillment: {
      fields: {
        estimatedDelivery: { visibility: 'hidden' },
        shippingAddress: { visibility: 'hidden' },
      },
    },
    FulfillmentLineItem: { fields: { notes: { visibility: 'hidden' } } },
  } as const;
}

/** General agreements: Keep signed agreements with customers, and see every contract in one list. */
export class AgreementsRecipe extends SmrtRecipe {
  static id = 'commerce.agreements';
  static help = './agreements.recipe.md';
  static label = 'General agreements';
  static summary =
    'Keep signed agreements with customers, and see every contract in one list.';
  static synonyms = ['contracts', 'terms', 'deals'];
  static group = {
    id: 'agreements',
    label: 'Agreements',
    summary:
      'Contracts with customers: general agreements, leases and licence sales.',
  };
  static section = {
    id: 'agreements',
    label: 'Agreements',
    icon: 'fileText',
    description: 'Contracts, leases and licenses with customers.',
  };
  static models = [Agreement, Contract, ContractLineItem];
  static nav = [
    {
      label: 'Agreements',
      model: Agreement,
      icon: 'fileText',
      description: 'Signed deals and terms with your customers, in one place.',
    },
    {
      label: 'All contracts',
      model: Contract,
      icon: 'fileText',
      description: 'Every contract you hold, whoever it is with.',
    },
  ];
  static requires = ['commerce.customers'];
  static options = {
    Agreement: {
      fields: {
        contractType: {
          default: 'agreement',
          visibility: 'hidden',
          locked: true,
        },
        customerId: { label: 'Customer', order: 1, required: true },
        vendorId: { visibility: 'hidden' },
        subtotal: { visibility: 'hidden' },
        taxAmount: { visibility: 'hidden' },
        channelId: { visibility: 'hidden' },
      },
    },
    ContractLineItem: {
      fields: {
        sku: { visibility: 'hidden' },
        startDate: { visibility: 'hidden' },
        endDate: { visibility: 'hidden' },
        billingPeriod: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
    Contract: { fields: { channelId: { visibility: 'hidden' } } },
  } as const;
}

/** Leases: Rent things out and track the term and the payments due. */
export class LeasesRecipe extends SmrtRecipe {
  static id = 'commerce.leases';
  static help = './leases.recipe.md';
  static label = 'Leases';
  static summary = 'Rent things out and track the term and the payments due.';
  static synonyms = ['rentals', 'renting', 'hire'];
  static group = {
    id: 'agreements',
    label: 'Agreements',
    summary:
      'Contracts with customers: general agreements, leases and licence sales.',
  };
  static section = {
    id: 'agreements',
    label: 'Agreements',
    icon: 'fileText',
    description: 'Contracts, leases and licenses with customers.',
  };
  static models = [Lease, ContractLineItem];
  static nav = [
    {
      label: 'Leases',
      model: Lease,
      icon: 'home',
      description: 'Rentals you give or take, with terms and dates.',
    },
  ];
  static requires = ['commerce.customers'];
  static options = {
    Lease: {
      fields: {
        contractType: { default: 'lease', visibility: 'hidden', locked: true },
        customerId: { label: 'Customer', order: 1, required: true },
        vendorId: { visibility: 'hidden' },
        subtotal: { visibility: 'hidden' },
        taxAmount: { visibility: 'hidden' },
        channelId: { visibility: 'hidden' },
      },
    },
    ContractLineItem: {
      fields: {
        sku: { visibility: 'hidden' },
        startDate: { visibility: 'hidden' },
        endDate: { visibility: 'hidden' },
        billingPeriod: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
  } as const;
}

/** Licence sales: Sell licences to software, content or other rights. */
export class LicensesRecipe extends SmrtRecipe {
  static id = 'commerce.licenses';
  static help = './licenses.recipe.md';
  static label = 'Licence sales';
  static summary = 'Sell licences to software, content or other rights.';
  static synonyms = ['licenses', 'licensing', 'subscriptions'];
  static group = {
    id: 'agreements',
    label: 'Agreements',
    summary:
      'Contracts with customers: general agreements, leases and licence sales.',
  };
  static section = {
    id: 'agreements',
    label: 'Agreements',
    icon: 'fileText',
    description: 'Contracts, leases and licenses with customers.',
  };
  static models = [LicenseSale, ContractLineItem];
  static nav = [
    {
      label: 'Licence sales',
      model: LicenseSale,
      icon: 'shoppingBag',
      description: 'Licences you have sold and who holds them.',
    },
  ];
  static requires = ['commerce.customers'];
  static options = {
    LicenseSale: {
      fields: {
        contractType: {
          default: 'license_sale',
          visibility: 'hidden',
          locked: true,
        },
        customerId: { label: 'Customer', order: 1, required: true },
        vendorId: { visibility: 'hidden' },
        subtotal: { visibility: 'hidden' },
        taxAmount: { visibility: 'hidden' },
        channelId: { visibility: 'hidden' },
      },
    },
    ContractLineItem: {
      fields: {
        sku: { visibility: 'hidden' },
        startDate: { visibility: 'hidden' },
        endDate: { visibility: 'hidden' },
        billingPeriod: { visibility: 'hidden' },
        sortOrder: { visibility: 'hidden' },
        discount: { visibility: 'hidden' },
        taxRate: { help: 'Type a percentage: 5 means 5%.' },
      },
    },
  } as const;
}
