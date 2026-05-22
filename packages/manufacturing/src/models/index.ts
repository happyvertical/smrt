/**
 * Model exports for `@happyvertical/smrt-manufacturing`.
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
  BillOfMaterials,
  type BillOfMaterialsOptions,
} from './BillOfMaterials.js';
export { BomLine, type BomLineOptions } from './BomLine.js';
