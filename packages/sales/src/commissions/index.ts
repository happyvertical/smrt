/**
 * `commissions` — the neutral financial core of `@happyvertical/smrt-sales`.
 *
 * Earners (payout accounts), versioned CommissionPlans, immutable
 * EarningEvents, Commissions with a strict settlement chain, append-only
 * CommissionAdjustments, computed balances, and CommissionPayout batches.
 *
 * This module never imports from the `crm` or `referrals` modules and never
 * assumes advertising, Referral, Lead, or Opportunity semantics — earning
 * sources are generic `(sourceKind, sourceId)` strings and terms snapshots
 * are generic `(termsSnapshotKind, termsSnapshotId)` references.
 *
 * @packageDocumentation
 */

export * from './collections/index.js';
export * from './models/index.js';
export * from './money.js';
export * from './services/index.js';
export * from './types.js';
