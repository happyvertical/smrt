import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { it } from 'vitest';
import { proveRetention } from './helpers/retention-suite.js';

it.skipIf(!isPostgresAvailable())(
  'preserves retained settlement, release, credits and rollback on PostgreSQL',
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
      ],
    });
    enableTenancy();
    try {
      await proveRetention(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);
