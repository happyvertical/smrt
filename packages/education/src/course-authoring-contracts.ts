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
  | 'read-enrollment'
  | 'create-question'
  | 'save-question'
  | 'read-question'
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
  | 'note-context-change';

/** Trusted identity supplied by the host session, never by a browser form. */
export interface CourseAuthoringActor {
  tenantId: string;
  actorUserId: string;
  /** Agent calls: the guardian whose delegation the host re-validates per check. */
  delegatingGuardianUserId?: string;
}

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
) => boolean | Promise<boolean>;

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
export type EnrollmentPinKind = 'initial' | 'explicit' | 'auto';
export type EnrollmentPinView = Readonly<{
  enrollmentId: string;
  courseId: string;
  releaseId: string;
  releaseNumber: number;
  kind: EnrollmentPinKind;
  autoUpgrade: boolean;
  /** Assignment-setting value the host relied on for the current pin. */
  policyBasis: string;
  history: ReadonlyArray<{
    releaseId: string;
    previousReleaseId: string | null;
    kind: EnrollmentPinKind;
    sequence: number;
    actorUserId: string | null;
    delegatingGuardianUserId: string | null;
    policyBasis: string;
    recordedAt: string;
  }>;
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
