import { CourseAuthoringError } from './course-authoring-contracts.js';

/**
 * Stored on every review. A review is an educator-assist record: it is never a
 * certification, accreditation, standards alignment or safety clearance.
 */
export const COURSE_REVIEW_DISCLAIMER =
  "This review is an aid for the family educator. It is not a certification, accreditation or standards alignment, and it does not replace the educator's own judgement. Items flagged for human verification must be checked by a person.";

export type CourseReviewSection = 'general-level' | 'individual-learner';
export const COURSE_REVIEW_SECTIONS: readonly CourseReviewSection[] = [
  'general-level',
  'individual-learner',
];
export type CourseReviewConcern =
  | 'factual-error'
  | 'answer-key'
  | 'missing-prerequisite'
  | 'level-mismatch'
  | 'clarity'
  | 'safety'
  | 'bias'
  | 'other';
export const COURSE_REVIEW_CONCERNS: readonly CourseReviewConcern[] = [
  'factual-error',
  'answer-key',
  'missing-prerequisite',
  'level-mismatch',
  'clarity',
  'safety',
  'bias',
  'other',
];
export type CourseReviewTargetKind =
  | 'course-revision'
  | 'lesson-revision'
  | 'question-revision';
export const COURSE_REVIEW_TARGET_KINDS: readonly CourseReviewTargetKind[] = [
  'course-revision',
  'lesson-revision',
  'question-revision',
];
export type CourseReviewOutdatedReason = 'revision-changed' | 'context-changed';
export type CourseFindingResolutionKind =
  | 'addressed'
  | 'dismissed'
  | 'verified';
export const COURSE_FINDING_RESOLUTIONS: readonly CourseFindingResolutionKind[] =
  ['addressed', 'dismissed', 'verified'];

/**
 * The mutable part of a review context. Level target and theme always come
 * from the reviewed revision itself, never from the caller.
 */
export interface CourseReviewContextInput {
  learnerId?: string;
  /** Opaque reference to the evidence snapshot the learner review used. */
  evidenceSnapshotRef?: string;
}
export interface CourseReviewContext {
  levelMin: number;
  levelMax: number;
  theme: string;
  learnerId: string | null;
  evidenceSnapshotRef: string | null;
}

/** A finding points at specific material and carries no score. */
export interface CourseReviewFindingInput {
  section: CourseReviewSection;
  target: {
    kind: CourseReviewTargetKind;
    /** Revision id of the course, lesson or question the finding concerns. */
    id: string;
    field: string;
    region?: string;
  };
  concern: CourseReviewConcern;
  explanation: string;
  suggestedChange?: string;
  /** The reviewer is not sure; shown as uncertain, never as a verdict. */
  uncertain?: boolean;
  /** A person must check this item; blocks release until verified. */
  humanVerificationRequired?: boolean;
  /** The reviewer judges the material unfit until addressed. */
  blocking?: boolean;
}

export interface CourseReviewFindingView {
  id: string;
  ordinal: number;
  section: CourseReviewSection;
  target: {
    kind: CourseReviewTargetKind;
    id: string;
    field: string;
    region: string;
  };
  concern: CourseReviewConcern;
  explanation: string;
  suggestedChange: string;
  uncertain: boolean;
  humanVerificationRequired: boolean;
  blocking: boolean;
  resolution: null | {
    resolution: CourseFindingResolutionKind;
    note: string;
    actorUserId: string;
    delegatingGuardianUserId: string | null;
    recordedAt: string;
  };
}
export interface CourseReviewView {
  id: string;
  courseId: string;
  revisionId: string;
  sequence: number;
  context: CourseReviewContext;
  contextDigest: string;
  disclaimer: string;
  reviewerKind: 'guardian' | 'agent';
  reviewerProvider: string;
  reviewerModel: string;
  authorUserId: string;
  delegatingGuardianUserId: string | null;
  recordedAt: string;
  /** Separate sections: general level suitability and this learner's. */
  sections: {
    generalLevel: { summary: string; findings: CourseReviewFindingView[] };
    individualLearner: null | {
      summary: string;
      findings: CourseReviewFindingView[];
    };
  };
  /** Derived from the live head and persisted markers; history is never deleted. */
  outdated: null | {
    reason: CourseReviewOutdatedReason;
    supersedingRevisionId: string | null;
  };
  /** Findings that stop release until resolved. */
  unresolvedBlocking: number;
}

export class CourseReviewNotFoundError extends CourseAuthoringError {
  constructor() {
    super('review-not-found', 'Review was not found.');
  }
}
export class CourseReviewTargetError extends CourseAuthoringError {
  constructor(readonly targetId: string) {
    super(
      'review-target-invalid',
      'A finding must reference material of the reviewed revision.',
    );
  }
}
export class CourseFindingNotFoundError extends CourseAuthoringError {
  constructor() {
    super('finding-not-found', 'Review finding was not found.');
  }
}
export class CourseFindingResolvedError extends CourseAuthoringError {
  constructor() {
    super('finding-already-resolved', 'This finding already has a resolution.');
  }
}
export class HumanVerificationRequiredError extends CourseAuthoringError {
  constructor() {
    super(
      'human-verification-required',
      'A person must verify this finding; a delegated agent cannot resolve it.',
    );
  }
}
