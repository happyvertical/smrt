import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { it } from 'vitest';
import { proveHistoricalCustomerFunds } from './helpers/historical-customer-funds-suite.js';
import { proveHistoricalSourceChildren } from './helpers/historical-lines-suite.js';

it.skipIf(!isPostgresAvailable())(
  'conserves historical cash, original retention chronology and new CAD journals on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Customer',
        'Contract',
        'Invoice',
        'InvoiceLineItem',
        'HistoricalSalesLine',
        'HistoricalCustomerFunds',
        'HistoricalCustomerFundsAllocation',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
        'Payment',
        'PaymentAllocation',
        'Account',
        'Journal',
        'JournalEntry',
      ],
    });
    enableTenancy();
    try {
      await proveHistoricalCustomerFunds(isolated.baseDb, true);
      await proveHistoricalSourceChildren(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
  60000,
);
