/**
 * Referrals module of `@happyvertical/smrt-sales`.
 *
 * Referrers, ReferralPrograms, versioned AttributionPolicies, share
 * links/codes, immutable ReferralTouch evidence, Referrals with guarded
 * lifecycles, the AttributionException review queue, versioned
 * ReferralAgreements, immutable ReferralTermSnapshots, and the services
 * that connect them: attribution, qualification, and the commission bridge.
 *
 * This module depends on `../commissions` (same package) for the neutral
 * financial core and NEVER on `../crm` — qualifying targets are generic
 * `(targetKind, targetId)` string pairs (see `packages/sales/AGENTS.md`).
 *
 * @packageDocumentation
 */

// Collections
export { AttributionExceptionCollection } from './collections/AttributionExceptionCollection.js';
export {
  type AttributionPolicyAmendmentChanges,
  AttributionPolicyCollection,
} from './collections/AttributionPolicyCollection.js';
export {
  type ReferralAgreementAmendmentChanges,
  ReferralAgreementCollection,
} from './collections/ReferralAgreementCollection.js';
export { ReferralCollection } from './collections/ReferralCollection.js';
export {
  type CreateReferralLinkInput,
  generateReferralCode,
  MAX_CODE_GENERATION_ATTEMPTS,
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  type RecordClickInput,
  type RecordClickRefusal,
  type RecordClickResult,
  ReferralLinkCollection,
} from './collections/ReferralLinkCollection.js';
export { ReferralProgramCollection } from './collections/ReferralProgramCollection.js';
export { ReferralTermSnapshotCollection } from './collections/ReferralTermSnapshotCollection.js';
export {
  ReferralTouchCollection,
  type TouchWindowQuery,
} from './collections/ReferralTouchCollection.js';
export { ReferrerCollection } from './collections/ReferrerCollection.js';
// Models
export { AttributionException } from './models/AttributionException.js';
export {
  AttributionPolicy,
  validateAttributionPolicyTerms,
} from './models/AttributionPolicy.js';
export { Referral } from './models/Referral.js';
export { ReferralAgreement } from './models/ReferralAgreement.js';
export { assertHttpTargetUrl, ReferralLink } from './models/ReferralLink.js';
export { ReferralProgram } from './models/ReferralProgram.js';
export { ReferralTermSnapshot } from './models/ReferralTermSnapshot.js';
export { ReferralTouch } from './models/ReferralTouch.js';
export { Referrer } from './models/Referrer.js';
// Services
export {
  type AttributionAward,
  type AttributionAwardResult,
  type AttributionRefusalReason,
  type AttributionResolution,
  AttributionService,
  type AttributionServiceDeps,
  type OverrideAttributionInput,
  QualifiedReferralOverrideError,
  type RecordManualAssignmentInput,
  type ResolveAttributionInput,
  type ResolveExceptionInput,
} from './services/AttributionService.js';
export {
  type ApplyExecutedReferralAgreementInput,
  REFERRAL_AGREEMENT_SOURCE_KIND,
  ReferralAgreementExecutionService,
  type ReferralAgreementExecutionServiceDeps,
  type RequestReferralAgreementSignatureInput,
} from './services/ReferralAgreementExecutionService.js';
export {
  type ProcessEarningEventInput,
  type ProcessEarningEventResult,
  REFERRAL_TERMS_SNAPSHOT_KIND,
  type ReferralCommissionOutcome,
  ReferralCommissionService,
  type ReferralCommissionServiceDeps,
  type ReferralProcessingSkip,
  type ReferralProcessingSkipReason,
} from './services/ReferralCommissionService.js';
export {
  type QualificationRefusalReason,
  type QualifyReferralInput,
  type QualifyReferralResult,
  ReferralQualificationService,
  type ReferralQualificationServiceDeps,
  type RequalifyReferralInput,
  type RequalifyReferralResult,
} from './services/ReferralQualificationService.js';
// Types, status unions, and shared contracts
export * from './types.js';
