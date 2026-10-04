/**
 * The assembly suite on PostgreSQL, run by `pnpm test:postgres` (and the
 * repository's PostgreSQL CI lane). Skipped without `DATABASE_URL`.
 */
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe } from 'vitest';
import { assemblySuite } from './assembly-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult | undefined;
  assemblySuite(
    'assembly (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'Product',
          'Material',
          'Assembly',
          'Operation',
          'Sku',
          'BillOfMaterials',
          'BomLine',
        ],
      });
      if (isolated.config.type !== 'postgres')
        throw new Error('Expected PostgreSQL');
      // The transaction-scoped handle: every row is rolled back by cleanup().
      return isolated.db as unknown as DatabaseInterface;
    },
    async () => {
      await isolated?.cleanup();
      isolated = undefined;
    },
  );
} else describe.skip('assembly (postgres; needs DATABASE_URL)', () => {});
