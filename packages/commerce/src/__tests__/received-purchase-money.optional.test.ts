import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import {
  proveReceivedPurchaseMoney,
  proveReceivedPurchaseRaces,
} from './helpers/received-purchase-money-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres('received purchase monetary authority on PostgreSQL', () => {
  it('preserves declared evidence, native transaction boundaries and tenant ownership', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'ContractLineItem',
        'Customer',
        'Vendor',
        'Invoice',
        'InvoiceLineItem',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
      ],
    });
    enableTenancy();
    try {
      expect(isolated.config.type).toBe('postgres');
      await proveReceivedPurchaseMoney(isolated.baseDb);
      await proveReceivedPurchaseRaces(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  });
});
