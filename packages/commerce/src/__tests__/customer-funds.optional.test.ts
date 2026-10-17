import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { it } from 'vitest';
import { proveCustomerFunds } from './helpers/customer-funds-suite.js';

it.skipIf(!isPostgresAvailable())(
  'serializes customer-funds refund versus application on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Customer',
        'Contract',
        'Invoice',
        'InvoiceLineItem',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
        'Payment',
        'PaymentIntent',
        'Payout',
        'PaymentAllocation',
        'Account',
        'Journal',
        'JournalEntry',
      ],
    });
    enableTenancy();
    try {
      await proveCustomerFunds(isolated.baseDb, true);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);
