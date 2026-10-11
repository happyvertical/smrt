/**
 * @happyvertical/smrt-approvals
 *
 * A small decision gate: a package defines an approval kind, a requester
 * opens a request bound to one subject revision, eligible humans decide,
 * and the consumer consumes the approval exactly once before acting.
 *
 * @example
 * ```typescript
 * import {
 *   ApprovalService,
 *   defineApprovalKind,
 * } from '@happyvertical/smrt-approvals';
 *
 * export const publishPost = defineApprovalKind({
 *   key: 'social.post.publish',
 *   subject: '@happyvertical/smrt-social:SocialPost',
 *   permission: 'social.approve-post',
 *   defaults: { requiredApprovals: 1 },
 * });
 *
 * const approvals = new ApprovalService({ db });
 * const { request } = await approvals.requestApproval(author, {
 *   kind: publishPost,
 *   subjectId: post.id,
 *   subjectRevisionHash: hashOf(post),
 * });
 * await approvals.decide(editor, request.id, { decision: 'approve' });
 * const used = await approvals.consume(publisher, request.id, hashOf(post));
 * if (used.outcome === 'transitioned') await publish(post);
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first. See __smrt-register__.ts (#1132).
import './__smrt-register__.js';
import { ensureApprovalPermissionsRegistered } from './permissions.js';

export { ApprovalEventCollection } from './collections/ApprovalEventCollection.js';
export { ApprovalPolicyCollection } from './collections/ApprovalPolicyCollection.js';
export { ApprovalRequestCollection } from './collections/ApprovalRequestCollection.js';
export {
  type ApprovalPolicyRules,
  assertPolicyTightens,
  DEFAULT_APPROVAL_TTL_MS,
  defineApprovalKind,
  effectiveRules,
  getApprovalKind,
  listApprovalKinds,
  MAX_APPROVAL_TTL_MS,
  MAX_REQUIRED_APPROVALS,
  MIN_APPROVAL_TTL_MS,
  requireApprovalKind,
  unregisterApprovalKind,
} from './kinds.js';
export {
  ApprovalEvent,
  type ApprovalEventOptions,
} from './models/ApprovalEvent.js';
export {
  ApprovalPolicy,
  type ApprovalPolicyOptions,
} from './models/ApprovalPolicy.js';
export {
  ApprovalRequest,
  type ApprovalRequestOptions,
} from './models/ApprovalRequest.js';
export {
  APPROVAL_PERMISSION_DEFINITIONS,
  CANCEL_ANY_APPROVAL_PERMISSION,
  ensureApprovalPermissionsRegistered,
  MANAGE_APPROVAL_POLICY_PERMISSION,
  registerApprovalPermissions,
} from './permissions.js';
export {
  type ApprovalResult,
  ApprovalService,
  type ApprovalServiceOptions,
  type ConsumeOptions,
  type DecideInput,
  type RequestApprovalInput,
} from './service.js';
export {
  APPROVAL_EVENT_TYPES,
  APPROVAL_PRINCIPAL_TYPES,
  APPROVAL_STATUSES,
  type ApprovalDecision,
  ApprovalError,
  type ApprovalErrorCode,
  type ApprovalEventType,
  type ApprovalKind,
  type ApprovalKindDefaults,
  type ApprovalKindInput,
  type ApprovalPrincipal,
  type ApprovalPrincipalType,
  type ApprovalRefusalReason,
  type ApprovalStatus,
  type ApprovalTransitionOutcome,
  type ApprovalTransitionResult,
  approvalPrincipalFromPermissions,
  type EffectiveApprovalRules,
} from './types.js';

ensureApprovalPermissionsRegistered();
