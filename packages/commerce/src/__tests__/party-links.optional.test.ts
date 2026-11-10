/** PostgreSQL UUID-column lane for the read-only party-link preflight (#3898). */
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightCommercePartyLinks } from '../migrations/partyLinks.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('commerce party-link preflight on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('reads native UUID party columns without comparing UUIDs to empty strings', async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'Customer',
        'Vendor',
        'Invoice',
        'Payment',
        'Fulfillment',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    const report = await preflightCommercePartyLinks(isolated.baseDb);
    expect(report.purchaseRowsWithCustomer).toEqual([]);
    expect(report.salesRowsWithVendor).toEqual([]);
    expect(report.invalidSalesReferences).toEqual([]);
    expect(report.invalidPurchaseReferences).toEqual([]);
  });
});
