/**
 * @happyvertical/smrt-sales
 *
 * Modular sales for the SMRT framework, shipped as one installable package
 * with distinct modules:
 *
 * - `agreements` (`@happyvertical/smrt-sales/agreements`): provider-neutral
 *   e-signature lifecycle, verified events, and immutable executed evidence.
 * - `crm` (`@happyvertical/smrt-sales/crm`): Leads, Opportunities,
 *   configurable Pipelines, sales activity, ownership, and idempotent
 *   conversion links.
 * - `referrals` (`@happyvertical/smrt-sales/referrals`): Referrers, Referral
 *   Programs, links/codes, attribution evidence, versioned attribution
 *   policies, referral agreements, and qualification term snapshots.
 * - `commissions` (`@happyvertical/smrt-sales/commissions`): neutral Earners,
 *   versioned Commission Plans, earning events, Commissions, append-only
 *   adjustments, payable balances, and CommissionPayout batches.
 * - `svelte` (`@happyvertical/smrt-sales/svelte`): reusable dashboard and
 *   Referrer/operator portal components.
 *
 * The root export re-exports every module for convenience; the subpath
 * exports keep consumers' bundles scoped to what they use.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below.
import './__smrt-register__.js';

export * from './agreements/index.js';
export * from './commissions/index.js';
export * from './crm/index.js';
export * from './referrals/index.js';
