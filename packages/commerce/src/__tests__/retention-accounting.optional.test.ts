import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { it } from 'vitest';
import { proveRetentionAccounting } from './helpers/retention-accounting-suite.js';

it.skipIf(!isPostgresAvailable())(
  'reconciles provider retention, release, credit and refund on PostgreSQL',
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
      await proveRetentionAccounting(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);
