/**
 * @happyvertical/smrt-ads
 *
 * Advertising delivery and tracking models for SMRT framework.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Collections
export {
  AdDeliveryTierCollection,
  AdEventCollection,
  AdFormatCollection,
  AdGroupCollection,
  AdVariationCollection,
} from './collections/index.js';

// Models
export {
  AdDeliveryTier,
  AdEvent,
  AdFormat,
  AdGroup,
  AdVariation,
} from './models/index.js';
// Types and enums
export {
  AdEventType,
  AdFormatType,
  AdGroupStatus,
  AdVariationStatus,
  PricingModel,
} from './types/index.js';
