import { CourseAuthoringError } from './course-authoring-contracts.js';
import type {
  GuardianWorksheetBundle,
  LearnerWorksheetBundle,
  QuestionAssistance,
  QuestionCompletionMode,
} from './question-contracts.js';

/**
 * The learner's answer to one question. Only these members are accepted so a
 * response can never smuggle other data; `choiceIds` must name the revision's
 * choices and `parts` keys its subparts.
 */
export interface QuestionResponseContent {
  text?: string;
  numeric?: number;
  choiceIds?: string[];
  parts?: Record<
    string,
    { text?: string; numeric?: number; choiceIds?: string[] }
  >;
}

/** Data-only view of one append-only response row. It carries no key or rubric. */
export interface QuestionResponseView {
  id: string;
  learnerId: string;
  enrollmentId: string;
  lessonRevisionId: string | null;
  questionRevisionId: string;
  worksheetVersionId: string;
  /** Groups one attempt and its corrections. */
  episodeId: string;
  attemptNumber: number;
  /** The response this row corrects, or null for a new attempt. */
  previousResponseId: string | null;
  completionMode: QuestionCompletionMode;
  assistance: QuestionAssistance;
  response: QuestionResponseContent;
  actorUserId: string;
  /** True when the author is not the learner (a guardian correction). */
  byGuardian: boolean;
  recordedAt: string;
}

/** Learner reads get the keyless bundle; guardians get the keyed one. */
export interface LessonQuestionResponses {
  worksheet: LearnerWorksheetBundle | GuardianWorksheetBundle;
  responses: QuestionResponseView[];
}

export class QuestionResponseValidationError extends CourseAuthoringError {
  constructor(message: string) {
    super('question-response-invalid', message);
  }
}
/** The question revision is not in the enrollment's effective lesson set. */
export class QuestionResponseScopeError extends CourseAuthoringError {
  constructor() {
    super(
      'question-response-out-of-scope',
      'The question revision is not part of this enrollment effective lesson.',
    );
  }
}
export class QuestionResponseNotFoundError extends CourseAuthoringError {
  constructor() {
    super('question-response-not-found', 'The response was not found.');
  }
}
