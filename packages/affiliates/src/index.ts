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
