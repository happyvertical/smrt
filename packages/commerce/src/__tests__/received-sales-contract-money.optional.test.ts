import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, it } from 'vitest';
import {
  proveReceivedSalesContractMoney,
  proveReceivedSalesContractRaces,
} from './helpers/received-sales-contract-money-suite.js';

const suite = isPostgresAvailable() ? describe : describe.skip;
suite('received sales contract PostgreSQL', () => {
  it('preserves authority, caller rollback and tenant/report isolation', async () => {
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
      await proveReceivedSalesContractMoney(isolated.baseDb);
      await proveReceivedSalesContractRaces(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  });
});
