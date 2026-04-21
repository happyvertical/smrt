/**
 * @happyvertical/smrt-affiliates
 *
 * Affiliate partner and commission tracking models for SMRT framework.
 *
 * This package provides models for tracking revenue sharing with partners:
 * - Partner: Entities that earn commissions (publishers, salespeople, referrers)
 * - Commission: Revenue attribution per ad event
 * - Payout: Aggregated payment batches
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__';

// Collections
export {
  CommissionCollection,
  PartnerCollection,
  PayoutCollection,
} from './collections/index.js';

// Models
export { Commission, Partner, Payout } from './models/index.js';

// Types and enums
export {
  CommissionStatus,
  CommissionType,
  PartnerStatus,
  PartnerType,
  PayoutMethod,
  PayoutStatus,
} from './types/index.js';
