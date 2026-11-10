import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { it } from 'vitest';
import { proveEstimateConversion } from './helpers/estimate-conversion-suite.js';

it.skipIf(!isPostgresAvailable())(
  'converts an accepted estimate idempotently and rolls back with its parent on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'ContractLineItem',
        'Customer',
        'Invoice',
        'InvoiceLineItem',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
        'PaymentAllocation',
      ],
    });
    enableTenancy();
    try {
      await proveEstimateConversion(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);
