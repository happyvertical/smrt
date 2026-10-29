import type {
  WorkbookAssessment,
  WorkbookConceptSummary,
} from './workbook-contracts.js';

export type GroupSharingSelector =
  | { mode: 'all' }
  | { mode: 'include'; values: string[] };
export interface GroupSharingPolicyV1 {
  schemaVersion: 1;
  shareWork: boolean;
  shareMedia: boolean;
  shareFeedback: boolean;
  shareProgress: boolean;
  parentReviewedOnly: boolean;
  commentVisibility: 'parent-only' | 'learner-visible';
  historyFrom: string;
  subjects: GroupSharingSelector;
  courseIds: GroupSharingSelector;
}
export interface GroupSharingActor {
  actorUserId: string;
  sessionId: string;
}
export interface GroupSharingScope extends GroupSharingActor {
  groupId: string;
  familyTenantId: string;
  learnerId: string;
}
export interface GroupSharedWorkSelector extends GroupSharingScope {
  activityId: string;
  attemptId: string;
  revisionId?: string;
}
export interface GroupSharingWorkFacts {
  capturedAt: string;
  courseId: string | null;
  subject: string | null;
  parentReviewed: boolean;
}
export interface GroupSharingDecision {
  eligible: boolean;
  work: boolean;
  media: boolean;
  feedback: boolean;
  progress: boolean;
  reasons: string[];
}
export type GroupLearnerInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'revoked'
  | 'declined';
export type GroupLearnerMembershipStatus = 'active' | 'revoked';
export interface EducationGroupView {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly active: boolean;
  readonly creatorUserId: string;
  readonly creatorProfileId: string;
}
export interface GroupLearnerInvitationView {
  readonly id: string;
  readonly groupId: string;
  readonly familyTenantId: string;
  readonly learnerId: string;
  readonly invitedParentUserId: string;
  readonly creatorUserId: string;
  readonly expiresAt: string;
  readonly status: GroupLearnerInvitationStatus;
  readonly acceptedMembershipId: string | null;
  readonly acceptedPolicyDigest: string;
}
/** Parent-only invitation detail; current exact guardian proof is required. */
export interface GroupLearnerParentInvitationView
  extends GroupLearnerInvitationView {
  readonly groupName: string;
  readonly learnerDisplayName: string;
}
export interface GroupLearnerMembershipView {
  readonly id: string;
  readonly familyTenantId: string;
  readonly groupId: string;
  readonly learnerId: string;
  readonly consentParentUserId: string;
  readonly status: GroupLearnerMembershipStatus;
  readonly policyVersion: number;
}
/** Family-owned participation summary retained after leaving or group disabling. */
export interface GroupLearnerMembershipSummaryView
  extends GroupLearnerMembershipView {
  readonly groupName: string;
  readonly groupActive: boolean;
}
export interface GroupSharingPolicyHistoryEntryView {
  readonly id: string;
  readonly membershipId: string;
  readonly familyTenantId: string;
  readonly version: number;
  readonly schemaVersion: 1;
  readonly policy: GroupSharingPolicyV1;
  readonly actorUserId: string;
  readonly recordedAt: string;
}
export interface GroupSharingPolicyHistoryView {
  readonly policies: ReadonlyArray<GroupSharingPolicyHistoryEntryView>;
  readonly nextAfterVersion: number | null;
}
/** Authorized roster identity; exposes no family account or profile metadata. */
export interface GroupLearnerRosterView extends GroupLearnerMembershipView {
  readonly learnerDisplayName: string;
}
export interface GroupSharedWorkView {
  readonly activityId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly capturedAt: string;
  readonly courseId: string | null;
  readonly subject: string | null;
  readonly facets: GroupSharingDecision;
  readonly revisionId: string | null;
  readonly commentRevisionId: string | null;
  readonly media: ReadonlyArray<{
    assetId: string;
    sha256: string;
    pageCount: number;
  }>;
}
export interface GroupSharedRevisionView {
  readonly activityId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly revisionId: string;
  readonly createdAt: string;
  readonly kind: 'ai' | 'guardian';
  readonly assessment: WorkbookAssessment;
}
export interface GroupSharingPreview {
  readonly policy: GroupSharingPolicyV1;
  readonly works: ReadonlyArray<{
    activityId: string;
    attemptId: string;
    submissionId: string;
    decision: GroupSharingDecision;
  }>;
}
export interface GroupSharedProgressView {
  readonly algorithmVersion: 'workbook-descriptive-v1';
  readonly counts: {
    attempts: number;
    episodes: number;
    assistance: { independent: number; assisted: number; unknown: number };
  };
  readonly concepts: ReadonlyArray<WorkbookConceptSummary>;
}
export interface GroupRevisionCommentView {
  readonly id: string;
  readonly familyTenantId: string;
  readonly membershipId: string;
  readonly learnerId: string;
  readonly activityId: string;
  readonly attemptId: string;
  readonly revisionId: string;
  readonly authorUserId: string;
  readonly authorProfileId: string;
  readonly body: string;
  readonly recordedAt: string;
  readonly childVisible: boolean;
  readonly visibilityActorUserId: string | null;
  readonly visibilityChangedAt: string | null;
  readonly visibilityVersion: number;
}
export class GroupSharingAuthorizationError extends Error {
  constructor(message = 'Group sharing authorization denied') {
    super(message);
    this.name = 'GroupSharingAuthorizationError';
  }
}
export class GroupSharingConflictError extends Error {
  constructor(message = 'Group sharing state conflict') {
    super(message);
    this.name = 'GroupSharingConflictError';
  }
}
export class GroupSharingPolicyValidationError extends Error {
  constructor(message = 'Invalid group sharing policy') {
    super(message);
    this.name = 'GroupSharingPolicyValidationError';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function keys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}
function selector(value: unknown): value is GroupSharingSelector {
  if (!record(value)) return false;
  if (value.mode === 'all') return keys(value, ['mode']);
  return (
    value.mode === 'include' &&
    keys(value, ['mode', 'values']) &&
    Array.isArray(value.values) &&
    value.values.length <= 1000 &&
    value.values.every(
      (v) =>
        typeof v === 'string' &&
        v.length > 0 &&
        v.length <= 256 &&
        v.trim() === v,
    ) &&
    new Set(value.values).size === value.values.length
  );
}
/** Reject missing/unknown fields and unsupported versions rather than widening consent. */
export function validateGroupSharingPolicy(
  value: unknown,
): asserts value is GroupSharingPolicyV1 {
  const booleans = [
    'shareWork',
    'shareMedia',
    'shareFeedback',
    'shareProgress',
    'parentReviewedOnly',
  ];
  if (
    !record(value) ||
    !keys(value, [
      'schemaVersion',
      ...booleans,
      'commentVisibility',
      'historyFrom',
      'subjects',
      'courseIds',
    ]) ||
    value.schemaVersion !== 1 ||
    !['parent-only', 'learner-visible'].includes(
      value.commentVisibility as string,
    ) ||
    !booleans.every((key) => typeof value[key] === 'boolean') ||
    typeof value.historyFrom !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.historyFrom) ||
    !Number.isFinite(Date.parse(value.historyFrom)) ||
    new Date(value.historyFrom).toISOString() !== value.historyFrom ||
    !selector(value.subjects) ||
    !selector(value.courseIds)
  )
    throw new GroupSharingPolicyValidationError();
}
/** Stable representation for immutable acceptance digests and policy snapshots. */
export function canonicalGroupSharingPolicy(value: unknown): string {
  validateGroupSharingPolicy(value);
  const ordered = (s: GroupSharingSelector): GroupSharingSelector =>
    s.mode === 'all'
      ? { mode: 'all' }
      : { mode: 'include', values: [...s.values].sort() };
  return JSON.stringify({
    schemaVersion: 1,
    shareWork: value.shareWork,
    shareMedia: value.shareMedia,
    shareFeedback: value.shareFeedback,
    shareProgress: value.shareProgress,
    parentReviewedOnly: value.parentReviewedOnly,
    commentVisibility: value.commentVisibility,
    historyFrom: value.historyFrom,
    subjects: ordered(value.subjects),
    courseIds: ordered(value.courseIds),
  });
}
/** Submitted opaque selectors only; conveys no family data or continuing authority. */
export interface GroupLearnerRosterEntryView {
  readonly id: string;
  readonly groupId: string;
  readonly familyTenantId: string;
  readonly learnerId: string;
  readonly membershipId: string;
}

/** Current guardian choices for this learner, independent of any group consent. */
export interface GroupSharingPolicyOptionsView {
  readonly courses: ReadonlyArray<{
    id: string;
    label: string;
    subject: string | null;
  }>;
  readonly subjects: ReadonlyArray<string>;
}
