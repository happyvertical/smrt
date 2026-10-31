import {
  type CourseAuthoringActor,
  CourseAuthoringError,
  type CourseLessonCompletion,
  type CourseLessonRevisionView,
  type CourseLessonType,
} from './course-authoring-contracts.js';
import type { QuestionRubric } from './question-rubric.js';

export type {
  QuestionRubric,
  QuestionRubricCriterion,
} from './question-rubric.js';

/** Supplied by the author, or inferred/generated/extracted by a tool. */
export type QuestionProvenance =
  | 'supplied'
  | 'inferred'
  | 'generated'
  | 'edited'
  | 'extracted';
export const QUESTION_PROVENANCES: readonly QuestionProvenance[] = [
  'supplied',
  'inferred',
  'generated',
  'edited',
  'extracted',
];
export type QuestionResponseType =
  | 'short-answer'
  | 'numeric'
  | 'multiple-choice'
  | 'multi-select'
  | 'true-false'
  | 'extended'
  | 'multi-part';
export const QUESTION_RESPONSE_TYPES: readonly QuestionResponseType[] = [
  'short-answer',
  'numeric',
  'multiple-choice',
  'multi-select',
  'true-false',
  'extended',
  'multi-part',
];
/** Where a learner completed the question; same completion vocabulary as workbooks. */
export type QuestionCompletionMode = 'printable' | 'online' | 'interactive';
export const QUESTION_COMPLETION_MODES: readonly QuestionCompletionMode[] = [
  'printable',
  'online',
  'interactive',
];
export type QuestionAssistance = 'independent' | 'assisted' | 'unknown';

/** Fields that carry their own provenance. A field that is absent has no entry. */
export type QuestionField =
  | 'prompt'
  | 'responseType'
  | 'choices'
  | 'subparts'
  | 'media'
  | 'objectives'
  | 'concepts'
  | 'answerKey'
  | 'rubric'
  | 'pointsPossible';
export const QUESTION_FIELDS: readonly QuestionField[] = [
  'prompt',
  'responseType',
  'choices',
  'subparts',
  'media',
  'objectives',
  'concepts',
  'answerKey',
  'rubric',
  'pointsPossible',
];

export interface QuestionChoice {
  id: string;
  label: string;
}
export interface QuestionSubpart {
  partKey: string;
  prompt: string;
  responseType?: Exclude<QuestionResponseType, 'multi-part'>;
  pointsPossible?: number;
}
export interface QuestionMediaRef {
  assetId: string;
  role?: 'figure' | 'passage' | 'audio' | 'other';
  alt?: string;
}
/** Atomic accepted answer(s). At least one member is required; never `{}`. */
export interface QuestionAnswerAtom {
  correctChoiceIds?: string[];
  acceptedAnswers?: string[];
  numeric?: { value: number; tolerance?: number };
}
export interface QuestionAnswerKey extends QuestionAnswerAtom {
  /** Per-subpart keys by `partKey`. */
  parts?: Record<string, QuestionAnswerAtom>;
  explanation?: string;
}

/** Everything an author states about one question revision. */
export interface QuestionContentInput {
  prompt: string;
  responseType: QuestionResponseType;
  choices?: QuestionChoice[];
  subparts?: QuestionSubpart[];
  media?: QuestionMediaRef[];
  /** Stable `LearningObjective` identity ids. */
  objectiveIds?: string[];
  conceptIds?: string[];
  /** Omit (or null) when no key exists: a missing key stays missing. */
  answerKey?: QuestionAnswerKey | null;
  rubric?: QuestionRubric | null;
  pointsPossible?: number | null;
  /** Default for every present field without its own entry. */
  provenance: QuestionProvenance;
  fieldProvenance?: Partial<Record<QuestionField, QuestionProvenance>>;
}

export interface QuestionRevisionView {
  id: string;
  questionId: string;
  parentRevisionId: string | null;
  sequence: number;
  prompt: string;
  responseType: QuestionResponseType;
  choices: QuestionChoice[];
  subparts: QuestionSubpart[];
  media: QuestionMediaRef[];
  objectives: Array<{
    objectiveId: string;
    externalKey: string;
    revisionId: string;
    statement: string;
  }>;
  conceptIds: string[];
  /** Null means no key was ever supplied; it is never an empty/zero key. */
  answerKey: QuestionAnswerKey | null;
  rubric: QuestionRubric | null;
  pointsPossible: number | null;
  provenance: QuestionProvenance;
  fieldProvenance: Partial<Record<QuestionField, QuestionProvenance>>;
  authorUserId: string;
  delegatingGuardianUserId: string | null;
  delegationId: string | null;
  recordedAt: string;
}
/** Most question revision ids one `resolveQuestionRevisions` call accepts. */
export const MAX_RESOLVE_QUESTION_REVISIONS = 200;
/** Longest `promptSummary`, in characters. */
export const QUESTION_PROMPT_SUMMARY_LENGTH = 200;
/**
 * A question revision as a host reference label. Never carries an answer key,
 * rubric, choices, media or provenance.
 */
export interface QuestionRevisionSummary {
  revisionId: string;
  questionId: string;
  sequence: number;
  responseType: QuestionResponseType;
  /** Plain-text excerpt of the prompt: whitespace collapsed, at most 200 characters. */
  promptSummary: string;
  /** Stable objective external keys; present only when the revision links objectives. */
  learningObjectiveKeys?: string[];
}
export interface ResolvedQuestionRevisions {
  /** Found revisions, in the order of the first occurrence of each requested id. */
  items: QuestionRevisionSummary[];
  /** Requested ids with no revision in this tenant (foreign and unknown are alike). */
  missing: string[];
}
export interface QuestionHeadView {
  questionId: string;
  /** The expected-head token for the next save. */
  headRevisionId: string;
  sequence: number;
}

export interface LearningObjectiveInput {
  statement: string;
  conceptIds?: string[];
  subject?: string;
  levelMin?: number;
  levelMax?: number;
  provenance?: QuestionProvenance;
}
export interface LearningObjectiveView {
  id: string;
  /** Stable key shared with consumers (for example hearthed.org#35). */
  externalKey: string;
  headRevisionId: string;
  sequence: number;
  statement: string;
  conceptIds: string[];
  subject: string;
  levelMin: number;
  levelMax: number;
  provenance: QuestionProvenance;
}

/** One ordered question in a lesson revision. Order is array order. */
export interface LessonQuestionRefInput {
  questionRevisionId: string;
  section?: string;
  column?: number;
  /** Source page/region where known; normalized `rect` is x, y, width, height. */
  anchor?: {
    assetId?: string;
    page?: number;
    rect?: [number, number, number, number];
  };
}
export type LessonLayoutParams = Record<string, string | number | boolean>;

/** Learner-facing item. Built from an allowlist, so keys and rubrics cannot leak. */
export interface LearnerQuestionItem {
  ordinal: number;
  questionId: string;
  questionRevisionId: string;
  section: string;
  column: number;
  anchor: LessonQuestionRefInput['anchor'] | null;
  prompt: string;
  responseType: QuestionResponseType;
  choices: QuestionChoice[];
  subparts: QuestionSubpart[];
  media: QuestionMediaRef[];
  pointsPossible: number | null;
}
export interface GuardianQuestionItem extends LearnerQuestionItem {
  answerKey: QuestionAnswerKey | null;
  rubric: QuestionRubric | null;
  fieldProvenance: Partial<Record<QuestionField, QuestionProvenance>>;
}
interface WorksheetBundleBase {
  /** Digest of ordered question revision ids and layout params. */
  worksheetVersionId: string;
  lessonRevisionId: string;
  layoutParams: LessonLayoutParams;
}
export interface LearnerWorksheetBundle extends WorksheetBundleBase {
  audience: 'learner';
  items: LearnerQuestionItem[];
}
export interface GuardianWorksheetBundle extends WorksheetBundleBase {
  audience: 'guardian';
  items: GuardianQuestionItem[];
}
export type WorksheetBundle = LearnerWorksheetBundle | GuardianWorksheetBundle;

export type QuestionActor = CourseAuthoringActor;

/**
 * Authoring/guardian read of one released lesson (`read-draft`): the full lesson
 * revision (materials and provenance included) and the keyed worksheet bundle.
 */
export type ReleasedLessonView = Readonly<{
  releaseId: string;
  courseId: string;
  lessonKey: string;
  lessonId: string;
  sectionId: string;
  lessonRevisionId: string;
  revision: CourseLessonRevisionView;
  worksheet: GuardianWorksheetBundle;
}>;

/**
 * Learner-safe read of one effective lesson. Built from an allowlist: no key,
 * rubric, provenance, material, source locator or licence detail. The body of a
 * personal-use-copy lesson is withheld (empty, `bodyWithheld`).
 */
export type LearnerLessonView = Readonly<{
  enrollmentId: string;
  releaseId: string;
  lessonKey: string;
  lessonId: string;
  lessonRevisionId: string;
  title: string;
  body: string;
  bodyWithheld: boolean;
  lessonType: CourseLessonType;
  completionRule: CourseLessonCompletion;
  estimatedMinutes: number;
  /** True when a started lesson stays on an older release than the current pin. */
  pinnedToOlderRelease: boolean;
  worksheet: LearnerWorksheetBundle;
}>;

export class QuestionNotFoundError extends CourseAuthoringError {
  constructor() {
    super('question-not-found', 'Question was not found.');
  }
}
export class LearningObjectiveNotFoundError extends CourseAuthoringError {
  constructor() {
    super('objective-not-found', 'Learning objective was not found.');
  }
}
export class LearningObjectiveKeyConflictError extends CourseAuthoringError {
  constructor() {
    super(
      'objective-key-conflict',
      'The objective key already names a different learning objective.',
    );
  }
}
/** A lesson revision named a question revision that is missing or foreign. */
export class QuestionReferenceError extends CourseAuthoringError {
  constructor(readonly references: readonly string[]) {
    super(
      'question-reference-invalid',
      'Lesson questions must reference existing immutable question revisions in this tenant.',
    );
  }
}

/** Audience of a generated printable: which artefact is produced, never authority. */
export type GeneratedPrintableAudience = 'learner' | 'guardian';
export const GENERATED_PRINTABLE_AUDIENCES: readonly GeneratedPrintableAudience[] =
  ['learner', 'guardian'];
/** `LessonAsset` relationship per audience: the learner copy is the only signable one. */
export type GeneratedPrintableRelationship = 'printable' | 'answer-key';
export const GENERATED_PRINTABLE_RELATIONSHIPS: Readonly<
  Record<GeneratedPrintableAudience, GeneratedPrintableRelationship>
> = { learner: 'printable', guardian: 'answer-key' };

/** Most question items one generated printable may carry. */
export const MAX_PRINTABLE_ITEMS = 200;
/** Longest single text value (prompt, choice, key, ...) rendered, in characters. */
export const MAX_PRINTABLE_TEXT_LENGTH = 10_000;
/** Most characters of all rendered text in one generated printable. */
export const MAX_PRINTABLE_TOTAL_TEXT = 400_000;
/** Most pages one generated printable may span. */
export const MAX_PRINTABLE_PAGES = 150;

/** Attach the rendered worksheet of a released lesson to the durable print queue. */
export type AttachGeneratedPrintableRequest = CourseAuthoringActor & {
  /** The materialised `lessons` row id of a released lesson. */
  lessonId: string;
  /** Must equal the worksheet version id of the lesson revision's questions and layout. */
  worksheetVersionId: string;
  audience: GeneratedPrintableAudience;
};
/** Closed result: never carries keys, answers or storage locators. */
export interface GeneratedPrintableResult {
  lessonId: string;
  worksheetVersionId: string;
  audience: GeneratedPrintableAudience;
  assetId: string;
  relationship: GeneratedPrintableRelationship;
  /** False when an earlier call already attached this printable. */
  created: boolean;
}

/** The request's worksheet version is unknown or no longer the lesson's own. */
export class WorksheetVersionMismatchError extends CourseAuthoringError {
  constructor() {
    super(
      'worksheet-version-mismatch',
      'The worksheet version is unknown or stale for this lesson.',
    );
  }
}
/** No asset runtime/storage was configured for generated printables. */
export class PrintableStorageNotConfiguredError extends CourseAuthoringError {
  constructor() {
    super(
      'printable-storage-not-configured',
      'Generated printables require a configured private asset storage.',
    );
  }
}
/** The acting guardian (or delegating guardian) has no profile to own the asset. */
export class PrintableOwnerError extends CourseAuthoringError {
  constructor() {
    super(
      'printable-owner-unavailable',
      'No owning profile is available for the generated printable.',
    );
  }
}
/**
 * A rolled-back attach could not remove its fresh private PDF(s). Carries the
 * fresh asset ids only, for operator reconciliation; the original cause is kept.
 */
export class PrintableStorageCleanupError extends CourseAuthoringError {
  constructor(
    readonly assetIds: readonly string[],
    cause: unknown,
  ) {
    super(
      'printable-storage-cleanup',
      `Printable rollback could not remove fresh assets: ${assetIds.join(', ')}`,
    );
    this.cause = cause;
  }
}
