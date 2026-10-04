/**
 * Collection exports for `@happyvertical/smrt-manufacturing`.
 *
 * Importing this barrel triggers `__smrt-register__.ts` first so the
 * package's build-time manifest is published before any class module
 * (transitively) imported by a collection touches the registry. See
 * `__smrt-register__.ts` and issue #1132 for the full background.
 *
 * @packageDocumentation
 */

import '../__smrt-register__.js';

export { AssemblyCollection } from './AssemblyCollection.js';
export { BillOfMaterialsCollection } from './BillOfMaterialsCollection.js';
export { BomLineCollection } from './BomLineCollection.js';
export { OperationCollection } from './OperationCollection.js';
export { RoutingStepCollection } from './RoutingStepCollection.js';
