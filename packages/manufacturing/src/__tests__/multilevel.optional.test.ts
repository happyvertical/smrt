/**
 * The multi-level suite on PostgreSQL, run by `pnpm test:postgres` (and the
 * repository's PostgreSQL CI lane). Skipped without `DATABASE_URL`.
 */
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe } from 'vitest';
import { multilevelSuite } from './multilevel-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult | undefined;
  multilevelSuite(
    'multi-level bills (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'Product',
          'Material',
          'Assembly',
          'Sku',
          'BillOfMaterials',
          'BomLine',
          'Operation',
          'RoutingStep',
          'StockLevel',
          'StockMovement',
          'InventoryLocation',
        ],
      });
      if (isolated.config.type !== 'postgres')
        throw new Error('Expected PostgreSQL');
      // The transaction-scoped handle: every row (products included, which
      // other suites list) is rolled back by cleanup().
      return isolated.db as unknown as DatabaseInterface;
    },
    async () => {
      await isolated?.cleanup();
      isolated = undefined;
    },
  );
} else
  describe.skip('multi-level bills (postgres; needs DATABASE_URL)', () => {});
