/**
 * Model exports for `@happyvertical/smrt-inventory`.
 *
 * Importing this barrel triggers `__smrt-register__.ts` first so the
 * package's build-time manifest is published before any `@smrt()`
 * decorator on a class module fires. See `__smrt-register__.ts` and
 * issue #1132 for the full background.
 *
 * @packageDocumentation
 */

import '../__smrt-register__.js';

export {
  InventoryLocation,
  type InventoryLocationOptions,
} from './InventoryLocation.js';
export { StockLevel, type StockLevelOptions } from './StockLevel.js';
export { StockMovement, type StockMovementOptions } from './StockMovement.js';
