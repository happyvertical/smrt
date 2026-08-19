/**
 * @happyvertical/smrt-support
 *
 * AI-first Support Cases for the SMRT framework (epic #1934): channel-neutral
 * Support Cases over chat and email transports, the standard case lifecycle
 * with reopen history, immediate AI assistance with lossless Human Handoff,
 * Project-qualified routing, Service Targets with timed escalation, and
 * auditable Service Time Entries with separated client charges and provider
 * compensation.
 *
 * Boundary: Support owns tickets, interactions, routing, and service targets.
 * Delivery Operations owns repository work — a Delivery Handoff links a case
 * to a Development Work Item without driving its execution.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below (issue #1132 context in __smrt-register__.ts).
import './__smrt-register__.js';

import { ensureSupportPermissionsRegistered } from './permissions.js';

// Major-units → integer minor-units migration (#2401)
export {
  migrateSupportMoneyToMinorUnits,
  preflightSupportMoneyMinorUnits,
  SUPPORT_MONEY_COLUMNS,
  SUPPORT_MONEY_MINOR_UNITS_BACKFILL,
} from './migrations/moneyMinorUnits.js';
export * from './models/index.js';
export {
  APPROVE_TIME_ENTRY_PERMISSION,
  ensureSupportPermissionsRegistered,
  MANAGE_PLANS_PERMISSION,
  REASSIGN_CASE_PERMISSION,
  registerSupportPermissions,
  SUPPORT_PERMISSION_DEFS,
  type SupportPrincipal,
  supportPrincipalFromPermissions,
} from './permissions.js';
export * from './services/index.js';
export * from './types.js';

// Contribute the support permission slugs to the runtime catalog on import,
// so any consumer of this package sees the gates' slugs.
ensureSupportPermissionsRegistered();
