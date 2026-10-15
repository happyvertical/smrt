import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { proveSupplierQuote } from './helpers/supplier-quote-suite.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres(
  'SupplierQuote public purchase contract on clean PostgreSQL',
  () => {
    it('persists qualified discriminator, enforces tenants, and rolls back', async () => {
      const isolated = await createIsolatedTestDbFromManifest({
        includeObjects: ['Contract', 'Customer', 'Vendor'],
      });
      enableTenancy();
      try {
        expect(isolated.config.type).toBe('postgres');
        await proveSupplierQuote(isolated.baseDb);
      } finally {
        disableTenancy();
        await isolated.cleanup();
      }
    });
  },
);
