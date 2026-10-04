/**
 * The production run suite on PostgreSQL, run by `pnpm test:postgres` (and the
 * repository's PostgreSQL CI lane). Skipped without `DATABASE_URL`.
 */
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe } from 'vitest';
import { productionRunSuite } from './production-run-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult | undefined;
  productionRunSuite(
    'production runs (postgres)',
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
          'ProductionRun',
          'ProductionRunCompletion',
          'StockLevel',
          'StockMovement',
          'InventoryLocation',
        ],
      });
      if (isolated.config.type !== 'postgres')
        throw new Error('Expected PostgreSQL');
      // The base handle: concurrent completions need their own transactions.
      return isolated.baseDb as unknown as DatabaseInterface;
    },
    async () => {
      await isolated?.cleanup();
      isolated = undefined;
    },
  );
} else
  describe.skip('production runs (postgres; needs DATABASE_URL)', () => {});
