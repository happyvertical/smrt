import { readFileSync } from 'node:fs';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { getTestManifestPath } from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { proveEstimateConversion } from './helpers/estimate-conversion-suite.js';

describe('estimate to order conversion (#4730)', () => {
  it('records lineage as STI meta fields without widening the base schema', () => {
    const manifest = JSON.parse(readFileSync(getTestManifestPath(), 'utf8'));
    const fields =
      manifest.objects['@happyvertical/smrt-commerce:Order'].fields;
    for (const name of [
      'sourceEstimateId',
      'conversionRequestId',
      'acceptanceEvidenceRef',
    ]) {
      expect(fields[name]).toMatchObject({
        type: 'meta',
        default: '',
        _meta: { underlyingType: 'text' },
      });
      expect(
        manifest.objects['@happyvertical/smrt-commerce:Contract'].fields[name],
      ).toBeUndefined();
    }
  });

  it('converts, replays and refuses on SQLite', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    try {
      await proveEstimateConversion(db);
    } finally {
      disableTenancy();
      await db.close?.();
    }
  });
});
