import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { it } from 'vitest';
import { proveContractSchedule } from './helpers/contract-schedule-suite.js';

it.skipIf(!isPostgresAvailable())(
  'serializes milestone claims and preserves parent rollback on PostgreSQL',
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
      await proveContractSchedule(isolated.baseDb, true);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);
