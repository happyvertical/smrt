import type { DatabaseInterface } from '@happyvertical/sql';
import type { CourseLicenseKind, CourseModality } from './catalog.js';
import type { LessonAssetRelationship } from './lesson-assets.js';
import type {
  LessonLayoutParams,
  LessonQuestionRefInput,
} from './question-contracts.js';

/** Authorizer actions. The host maps roles; the service never infers a role. */
export type CourseAuthoringAction =
  | 'education.course.read-draft'
  | 'education.course.author'
  | 'education.course.generate'
  | 'education.course.review'
  | 'education.course.release'
  | 'education.course.assign'
  | 'education.course.archive';

export const COURSE_AUTHORING_ACTIONS: readonly CourseAuthoringAction[] = [
  'education.course.read-draft',
  'education.course.author',
  'education.course.generate',
  'education.course.review',
  'education.course.release',
  'education.course.assign',
  'education.course.archive',
];

/** Which service operation asked, so a host can deny agents specific operations. */
export type CourseAuthoringOperation =
  | 'create'
  | 'save-draft'
  | 'read-draft'
  | 'release'
  | 'archive'
  | 'unarchive'
  | 'discard'
  | 'pin-enrollment'
  | 'upgrade-enrollment'
  | 'set-auto-upgrade'
  | 'auto-upgrade'
  | 'read-enrollment'
  | 'create-question'
  | 'save-question'
  | 'read-question'
  | 'resolve-question-revisions'
  | 'create-objective'
  | 'save-objective'
  | 'link-objectives'
  | 'read-worksheet'
  | 'request-generation'
  | 'run-generation'
  | 'cancel-generation'
  | 'accept-proposal'
  | 'read-generation'
  | 'record-review'
  | 'read-review'
  | 'resolve-finding'
  | 'note-context-change'
  | 'list-courses'
  | 'list-upgrade-choices'
  | 'list-auto-upgrade-skips'
  | 'read-released-lesson';

/** Trusted identity supplied by the host session, never by a browser form. */
export interface CourseAuthoringActor {
  tenantId: string;
  actorUserId: string;
  /** Agent calls: the guardian whose delegation the host re-validates per check. */
  delegatingGuardianUserId?: string;
  /**
   * Host-supplied opaque delegation id (1-200 printable characters), required
   * with, and only with, `delegatingGuardianUserId`. Recorded on every decision
   * and passed to every authorizer call; it grants nothing by itself.
   */
  delegationId?: string;
}

/**
 * A richer authorizer answer. `reason` (at most 200 characters) and `code` (a
 * short token, at most 64 characters of `[a-z0-9._-]`) are recorded on an
 * auto-upgrade skip when `allowed` is false; invalid values are dropped, never
 * thrown. A plain `boolean` stays valid everywhere.
 */
export interface CourseAuthorizationDecision {
  allowed: boolean;
  reason?: string;
  code?: string;
}

/** Result of a host delegation check; a bare boolean is accepted as well. */
export type CourseDelegationDecision =
  | boolean
  | { allowed: boolean; reason?: string; code?: string };

/**
 * Host port that verifies a delegation (the agent may act for the guardian under
 * this id) on the supplied transaction executor. Without it every delegated
 * request is refused; it runs before the host authorizer and never grants by
 * itself.
 */
export type CourseDelegationVerifier = (
  executor: DatabaseInterface,
  request: {
    tenantId: string;
    actorUserId: string;
    delegatingGuardianUserId: string;
    delegationId: string;
    action: CourseAuthoringAction;
    operation: CourseAuthoringOperation;
    courseId?: string;
    enrollmentId?: string;
    learnerId?: string;
  },
) => CourseDelegationDecision | Promise<CourseDelegationDecision>;

export type CourseAuthoringAuthorizer = (
  request: CourseAuthoringActor & {
    action: CourseAuthoringAction;
    operation: CourseAuthoringOperation;
    /** The active service executor; host policy reads must share its transaction. */
    executor: DatabaseInterface;
    courseId?: string;
    enrollmentId?: string;
    learnerId?: string;
  },
) =>
  | boolean
  | CourseAuthorizationDecision
  | Promise<boolean | CourseAuthorizationDecision>;

export type CourseProvenance =
  | 'supplied'
  | 'generated'
  | 'edited'
  | 'extracted';
export const COURSE_PROVENANCES: readonly CourseProvenance[] = [
  'supplied',
  'generated',
  'edited',
  'extracted',
];
export type CourseLessonType = 'reading' | 'video' | 'worksheet' | 'exercise';
export type CourseLessonCompletion = 'attest' | 'submit' | 'score' | 'external';

/** Hook supplied by #4516; the service never treats an absent gate as a pass. */
export type ReleaseReviewGate = (
  executor: DatabaseInterface,
  request: { tenantId: string; courseId: string; revisionId: string },
) =>
  | { current: boolean; reviewId?: string; reason?: string }
  | Promise<{ current: boolean; reviewId?: string; reason?: string }>;

/** Hook supplied by #4516/variants: report review/variant rows that reference a draft. */
export type CourseReferenceGuard = (
  executor: DatabaseInterface,
  request: { tenantId: string; courseId: string },
) =>
  | { referenced: boolean; kinds?: readonly string[] }
  | Promise<{ referenced: boolean; kinds?: readonly string[] }>;

/** Copies an upload (for example an ingestion item) to an education-owned asset. */
export interface CourseMaterialSource {
  kind: string;
  ref: string;
}
export interface CourseMaterialCopyRequest {
  tenantId: string;
  actorUserId: string;
  courseId: string;
  source: CourseMaterialSource;
  relationship: LessonAssetRelationship;
}
export interface CourseMaterialCopyPort {
  /** Must return an asset owned by the same tenant, independent of the source's expiry. */
  copy(
    executor: DatabaseInterface,
    request: CourseMaterialCopyRequest,
  ): Promise<{ assetId: string }>;
}

export interface CourseMaterialInput {
  /** Uploaded material to copy; mutually exclusive with `assetId`. */
  source?: CourseMaterialSource;
  /** Reuse an asset already copied into this course by an earlier revision. */
  assetId?: string;
  relationship: LessonAssetRelationship;
  licenseKind?: CourseLicenseKind;
}
export interface CourseMaterialView {
  assetId: string;
  relationship: LessonAssetRelationship;
  licenseKind: CourseLicenseKind;
  provenance: {
    source: CourseMaterialSource | null;
    copiedAt: string;
    copiedByUserId: string;
  };
}

export interface CourseLessonInput {
  /** Stable cross-version identity; omit for a new lesson. */
  lessonKey?: string;
  title: string;
  body?: string;
  lessonType?: CourseLessonType;
  completionRule?: CourseLessonCompletion;
  estimatedMinutes?: number;
  difficulty?: number;
  modality?: CourseModality;
  externalRef?: string;
  externalUrl?: string;
  licenseKind?: CourseLicenseKind;
  provenance?: CourseProvenance;
  fieldProvenance?: Record<string, CourseProvenance>;
  materials?: CourseMaterialInput[];
  /** Ordered immutable question revisions; each must exist in this tenant. */
  questions?: LessonQuestionRefInput[];
  /** Flat render parameters folded into the worksheet version id. */
  layoutParams?: LessonLayoutParams;
}
export interface CourseSectionInput {
  sectionKey: string;
  title: string;
  lessons: CourseLessonInput[];
}
export interface CourseDraftInput {
  title: string;
  summary?: string;
  subject?: string;
  theme?: string;
  levelMin?: number;
  levelMax?: number;
  objectives?: string[];
  sections: CourseSectionInput[];
  provenance: CourseProvenance;
  fieldProvenance?: Record<string, CourseProvenance>;
}

export interface CourseLessonRevisionView {
  id: string;
  lessonKey: string;
  parentRevisionId: string | null;
  title: string;
  body: string;
  lessonType: CourseLessonType;
  completionRule: CourseLessonCompletion;
  estimatedMinutes: number;
  difficulty: number;
  modality: CourseModality;
  externalRef: string;
  externalUrl: string;
  licenseKind: CourseLicenseKind;
  provenance: CourseProvenance;
  fieldProvenance: Record<string, CourseProvenance>;
  materials: CourseMaterialView[];
  questions: LessonQuestionRefInput[];
  layoutParams: LessonLayoutParams;
}
/** Alias for hosts: a lesson revision as read by the authoring views. */
export type LessonRevisionView = CourseLessonRevisionView;
export interface CourseRevisionView {
  id: string;
  courseId: string;
  parentRevisionId: string | null;
  sequence: number;
  title: string;
  summary: string;
  subject: string;
  theme: string;
  levelMin: number;
  levelMax: number;
  objectives: string[];
  licenseKind: CourseLicenseKind;
  provenance: CourseProvenance;
  fieldProvenance: Record<string, CourseProvenance>;
  authorUserId: string;
  delegatingGuardianUserId: string | null;
  delegationId: string | null;
  recordedAt: string;
  sections: Array<{
    sectionKey: string;
    title: string;
    lessons: CourseLessonRevisionView[];
  }>;
}
export interface CourseHeadView {
  courseId: string;
  /** The expected-head token for the next save. */
  headRevisionId: string;
  version: number;
}
export type CourseReleaseView = Readonly<{
  id: string;
  courseId: string;
  revisionId: string;
  releaseNumber: number;
  releaseCourseId: string;
  reviewId: string | null;
  actorUserId: string;
  delegatingGuardianUserId: string | null;
  delegationId: string | null;
  recordedAt: string;
  lessons: ReadonlyArray<{
    lessonKey: string;
    lessonRevisionId: string;
    lessonId: string;
    sectionId: string;
  }>;
}>;
export type CourseLifecycleState =
  | 'draft'
  | 'released'
  | 'archived'
  | 'discarded';
export type CourseStateView = Readonly<{
  courseId: string;
  title: string;
  state: CourseLifecycleState;
  licenseKind: CourseLicenseKind;
  /** Personal-use material makes the course tenant-private and never group-shareable. */
  groupShareable: boolean;
  headRevisionId: string | null;
  releases: ReadonlyArray<{
    id: string;
    releaseNumber: number;
    revisionId: string;
    releaseCourseId: string;
  }>;
}>;
/** Largest page a list read returns; the default is `DEFAULT_PAGE_SIZE`. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/** Opaque, deterministic pagination: pass back `nextCursor` unchanged. */
export interface CoursePageRequest {
  limit?: number;
  cursor?: string;
}
export type CoursePage<T> = Readonly<{
  items: ReadonlyArray<T>;
  /** Null on the last page. */
  nextCursor: string | null;
}>;

export type CourseArchiveDecisionView = Readonly<{
  action: 'archive' | 'unarchive';
  sequence: number;
  actorUserId: string;
  delegatingGuardianUserId: string | null;
  delegationId: string | null;
  recordedAt: string;
}>;
/** One authored course in `listCourses`. */
export type CourseSummaryView = Readonly<{
  courseId: string;
  title: string;
  state: CourseLifecycleState;
  createdAt: string;
  /**
   * Effective licence: the most restrictive of the head revision and every release's
   * materialized course, so a restriction recorded by any release never loosens.
   * `CourseStateView.licenseKind` reads the head alone and may be looser.
   */
  licenseKind: CourseLicenseKind;
  /**
   * The group-sharing rule applied to this course: false for personal-use and
   * false until the course has a release (nothing to share).
   */
  groupShareable: boolean;
  /** Number of releases (0 for a draft-only course). */
  releaseCount: number;
  /** The draft head; `revisionId` is the expected-head token for the next save. */
  head: Readonly<{
    revisionId: string;
    sequence: number;
    version: number;
  }> | null;
  latestRelease: Readonly<{
    id: string;
    revisionId: string;
    releaseNumber: number;
    releaseCourseId: string;
    recordedAt: string;
  }> | null;
  archive: Readonly<{
    archived: boolean;
    latestDecision: CourseArchiveDecisionView | null;
  }>;
}>;

export type CourseUpgradeChoiceView = Readonly<{
  id: string;
  courseId: string;
  scope: 'course' | 'enrollment';
  /** Null for a course-level choice. */
  enrollmentId: string | null;
  enabled: boolean;
  kind: 'opt-in' | 'opt-out';
  sequence: number;
  actorUserId: string;
  delegatingGuardianUserId: string | null;
  delegationId: string | null;
  policyBasis: string;
  recordedAt: string;
}>;

export type AutoUpgradeSkipView = Readonly<{
  id: string;
  enrollmentId: string;
  learnerId: string;
  courseId: string;
  releaseId: string;
  optInScope: 'course' | 'enrollment';
  optInActorUserId: string;
  optInDelegatingGuardianUserId: string | null;
  optInDelegationId: string | null;
  policyBasis: string;
  /** The authorizer's reason when it gave one, else `not-authorized`. */
  reason: string;
  /** The authorizer's short code, or an empty string. */
  code: string;
  recordedAt: string;
}>;

export type EnrollmentPinKind = 'initial' | 'explicit' | 'auto';
export type EnrollmentPinView = Readonly<{
  enrollmentId: string;
  /** The enrollment's learner, from the enrollment row; hosts never read `enrollments`. */
  learnerId: string;
  /** The authored course identity (`AuthoredCourse` id) the pin follows. */
  courseId: string;
  releaseId: string;
  /** The materialized release `Course` id the enrollment is created on. */
  releaseCourseId: string;
  releaseNumber: number;
  kind: EnrollmentPinKind;
  autoUpgrade: boolean;
  /** Assignment-setting value the host relied on for the current pin. */
  policyBasis: string;
  history: ReadonlyArray<{
    releaseId: string;
    releaseCourseId: string;
    previousReleaseId: string | null;
    kind: EnrollmentPinKind;
    sequence: number;
    actorUserId: string | null;
    delegatingGuardianUserId: string | null;
    delegationId: string | null;
    policyBasis: string;
    /** For automatic moves: the scope of the opt-in followed. */
    optInScope: 'course' | 'enrollment' | null;
    recordedAt: string;
  }>;
}>;
/** Result of `getEnrollmentRelease`; identity fields repeat the pin's for convenience. */
export type EnrollmentReleaseView = Readonly<{
  learnerId: string;
  courseId: string;
  releaseCourseId: string;
  pin: EnrollmentPinView;
  lessons: EffectiveLessonView[];
}>;
/** Result of `setAutoUpgrade`; `learnerId` is null for a course-level choice. */
export type SetAutoUpgradeResult = Readonly<{
  courseId: string;
  enrollmentId: string | null;
  learnerId: string | null;
  enabled: boolean;
  policyBasis: string;
}>;
export type EffectiveLessonView = Readonly<{
  lessonKey: string;
  lessonId: string;
  releaseId: string;
  /** True when a started lesson stays on an older release than the current pin. */
  pinnedToOlderRelease: boolean;
}>;

export class CourseAuthoringError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class CourseAuthoringAuthorizationError extends CourseAuthoringError {
  constructor() {
    super('not-authorized', 'Course authoring access is not authorized.');
  }
}
export class CourseAuthoringValidationError extends CourseAuthoringError {
  constructor(message: string) {
    super('invalid-request', message);
  }
}
export class CourseNotFoundError extends CourseAuthoringError {
  constructor() {
    super('course-not-found', 'Course was not found.');
  }
}
export class CourseDiscardedError extends CourseAuthoringError {
  constructor() {
    super('course-discarded', 'Course draft was discarded.');
  }
}
export class CourseArchivedError extends CourseAuthoringError {
  constructor() {
    super('course-archived', 'Course is archived; unarchive it first.');
  }
}
export class CourseStaleHeadError extends CourseAuthoringError {
  constructor(readonly currentHeadRevisionId: string) {
    super('stale-head', 'The draft head moved; reload and retry.');
  }
}
export class CourseRequestKeyConflictError extends CourseAuthoringError {
  constructor() {
    super(
      'request-key-conflict',
      'The request key was already used for a different request.',
    );
  }
}
export class ReviewGateRequiredError extends CourseAuthoringError {
  constructor() {
    super(
      'review-gate-required',
      'Release requires a configured review gate; none is configured.',
    );
  }
}
export class ReviewNotCurrentError extends CourseAuthoringError {
  constructor(readonly reason?: string) {
    super(
      'review-not-current',
      'Release requires a current review of this exact revision.',
    );
  }
}
export class CourseRevisionAlreadyReleasedError extends CourseAuthoringError {
  constructor(readonly releaseId: string) {
    super('revision-already-released', 'This revision is already released.');
  }
}
export class CourseDiscardRefusedError extends CourseAuthoringError {
  constructor(readonly references: readonly string[]) {
    super(
      'discard-refused',
      'Only drafts with no release, enrollment, attempt, review or variant can be discarded.',
    );
  }
}
export class EnrollmentPinConflictError extends CourseAuthoringError {
  constructor(
    message = 'Enrollment pin request conflicts with current state.',
  ) {
    super('enrollment-pin-conflict', message);
  }
}
export class CourseMaterialCopyError extends CourseAuthoringError {
  constructor(
    message = 'Course material could not be copied to an owned asset.',
  ) {
    super('material-copy-failed', message);
  }
}
