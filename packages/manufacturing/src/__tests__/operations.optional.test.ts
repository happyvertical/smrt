import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe } from 'vitest';
import { operationsSuite } from './operations-suite.js';

if (isPostgresAvailable()) {
  let isolated: IsolatedTestDbResult;
  operationsSuite(
    'operations and routing (postgres)',
    async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
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
      return isolated.baseDb;
    },
    async () => {
      await isolated?.cleanup();
    },
  );
} else
  describe.skip('operations and routing (postgres; needs database)', () => {});
