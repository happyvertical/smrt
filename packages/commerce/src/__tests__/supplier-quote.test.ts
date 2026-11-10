import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { proveSupplierQuote } from './helpers/supplier-quote-suite.js';

describe('SupplierQuote public purchase contract', () => {
  it('persists supplier identity and isolates tenants and rollback on SQLite', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    try {
      await proveSupplierQuote(db);
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
  it('preserves the explicit unsupported DuckDB Contract foreign-key boundary', async () => {
    await expect(
      getTestDatabase({
        type: 'duckdb',
        url: ':memory:',
        classes: ['Contract', 'Customer', 'Vendor'],
      }),
    ).rejects.toThrow('DuckDB cannot preserve SMRT');
  });
});
