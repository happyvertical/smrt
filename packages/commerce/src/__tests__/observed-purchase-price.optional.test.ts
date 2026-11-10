import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { proveObservedPurchasePrice } from './helpers/observed-purchase-price-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres('observed purchase monetary authority on PostgreSQL', () => {
  it('preserves declared evidence, native transaction boundaries and tenant ownership', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'PurchasePriceObservation',
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
      await proveObservedPurchasePrice(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  });
});
