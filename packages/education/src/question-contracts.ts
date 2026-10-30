import {
  type CourseAuthoringActor,
  CourseAuthoringError,
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
  recordedAt: string;
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
