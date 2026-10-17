import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { it } from 'vitest';
import { proveOrdinaryAccounting } from './helpers/ordinary-accounting-suite.js';

it.skipIf(!isPostgresAvailable())(
  'reconciles ordinary provider credit/refund coordination on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Customer',
        'Invoice',
        'InvoiceLineItem',
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
      await proveOrdinaryAccounting(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);
