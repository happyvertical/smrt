/**
 * Collection exports for `@happyvertical/smrt-inventory`.
 *
 * Importing this barrel triggers `__smrt-register__.ts` first so the
 * package's build-time manifest is published before any class module
 * (transitively) imported by a collection touches the registry. See
 * `__smrt-register__.ts` and issue #1132 for the full background.
 *
 * @packageDocumentation
 */

import '../__smrt-register__.js';

export { InventoryLocationCollection } from './InventoryLocationCollection.js';
export { LotCollection, lotSearchKey } from './LotCollection.js';
export { LotCorrectionCollection } from './LotCorrectionCollection.js';
export { LotDocumentCollection } from './LotDocumentCollection.js';
export { LotStockLevelCollection } from './LotStockLevelCollection.js';
export { LotUsageCollection } from './LotUsageCollection.js';
export { StockLevelCollection } from './StockLevelCollection.js';
export { StockMovementCollection } from './StockMovementCollection.js';
