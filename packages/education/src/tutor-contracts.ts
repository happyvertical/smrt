import { LearnerValidationError } from './learner-service.js';

export const TUTOR_AUDIENCES = ['learner', 'guardian'] as const;
export type TutorAudience = (typeof TUTOR_AUDIENCES)[number];
export const TUTOR_SESSION_MODES = ['chat', 'voice'] as const;
export type TutorSessionMode = (typeof TUTOR_SESSION_MODES)[number];
export const TUTOR_EXCHANGE_ROLES = ['learner', 'tutor', 'system'] as const;
export type TutorExchangeRole = (typeof TUTOR_EXCHANGE_ROLES)[number];
/** Host content/safety classification of one exchange; `none` is unclassified. */
export const TUTOR_EXCHANGE_MARKERS = [
  'none',
  'filtered',
  'redacted',
  'flagged',
] as const;
export type TutorExchangeMarker = (typeof TUTOR_EXCHANGE_MARKERS)[number];

// -- context bounds ----------------------------------------------------------
/** Longest lesson body, in characters; longer text is cut and `truncated` set. */
export const MAX_TUTOR_BODY_CHARS = 8000;
/** Longest question prompt, subpart prompt or choice label, in characters. */
export const MAX_TUTOR_PROMPT_CHARS = 2000;
/** Longest answer key or rubric text (guardian audience), in characters. */
export const MAX_TUTOR_KEY_CHARS = 2000;
/** Longest released-feedback text, in characters. */
export const MAX_TUTOR_FEEDBACK_CHARS = 2000;
/** Longest title or objective statement, in characters. */
export const MAX_TUTOR_TITLE_CHARS = 300;
export const MAX_TUTOR_QUESTIONS = 30;
export const MAX_TUTOR_CHOICES = 12;
export const MAX_TUTOR_SUBPARTS = 12;
export const MAX_TUTOR_OBJECTIVES = 10;
/** Serialized size ceiling of a whole context; trailing questions drop first. */
export const MAX_TUTOR_CONTEXT_CHARS = 48_000;

// -- session bounds ----------------------------------------------------------
/** Longest exchange text, in characters. Over-cap or empty text is refused. */
export const MAX_TUTOR_EXCHANGE_TEXT_CHARS = 4000;
export const MAX_TUTOR_TOOL_SUMMARY_CHARS = 1000;
export const DEFAULT_TUTOR_SESSION_PAGE = 20;
export const MAX_TUTOR_SESSION_PAGE = 50;
export const DEFAULT_TUTOR_EXCHANGE_PAGE = 50;
export const MAX_TUTOR_EXCHANGE_PAGE = 200;

export type TutorQuestionItem = Readonly<{
  ordinal: number;
  questionRevisionId: string;
  prompt: string;
  responseType: string;
  choices: ReadonlyArray<{ id: string; label: string }>;
  subparts: ReadonlyArray<{ partKey: string; prompt: string }>;
  pointsPossible: number | null;
  /** Guardian audience only: answer key as capped JSON text. */
  answerKey?: string | null;
  /** Guardian audience only: rubric as capped JSON text. */
  rubric?: string | null;
}>;

/**
 * Bounded, data-only view a host may turn into tutor prompts. For the learner
 * audience it holds no answer key, rubric, guardian note, storage locator,
 * asset id, other learner's data or grading internals; only
 * `answerKeyAvailable` says that a key exists.
 */
export type TutorContext = Readonly<{
  version: 1;
  audience: TutorAudience;
  learner: Readonly<{
    id: string;
    displayName: string;
    level: number;
    /**
     * The learner's interest theme (short label, optional key), or null. It
     * colours stories and examples only and never changes an objective.
     */
    interestTheme: Readonly<{ label: string; key: string }> | null;
  }>;
  enrollment: Readonly<{
    id: string;
    courseId: string;
    status: string;
    lessonsPerWeek: number | null;
  }> | null;
  course: Readonly<{ id: string; title: string }> | null;
  section: Readonly<{ title: string }> | null;
  lesson: Readonly<{
    id: string;
    title: string;
    kind: string;
    /** Learner-facing lesson text; empty when withheld or absent. */
    body: string;
    bodyWithheld: boolean;
    estimatedMinutes: number;
  }> | null;
  objectives: ReadonlyArray<string>;
  progress: Readonly<{
    status: string;
    completedAt: string | null;
  }> | null;
  questions: ReadonlyArray<TutorQuestionItem>;
  /** The question the tutor is asked about, when one was requested. */
  focusQuestionRevisionId: string | null;
  submissions: Readonly<{ count: number; latestStatus: string | null }>;
  /** Latest explicitly released feedback text for the lesson, if any. */
  feedback: Readonly<{ text: string }> | null;
  answerKeyAvailable: boolean;
  /** True when any text or list was cut to fit a bound. */
  truncated: boolean;
  /** Digest of this context; sessions store it instead of the text. */
  contextHash: string;
}>;

export class TutorSessionClosedError extends LearnerValidationError {
  constructor() {
    super('The tutor session is closed');
    this.name = 'TutorSessionClosedError';
  }
}
export class TutorRequestKeyConflictError extends LearnerValidationError {
  constructor() {
    super('The request key was already used for a different tutor request');
    this.name = 'TutorRequestKeyConflictError';
  }
}
export class TutorConsentRequiredError extends LearnerValidationError {
  constructor() {
    super('A voice tutor session requires recorded consent');
    this.name = 'TutorConsentRequiredError';
  }
}
export class TutorExchangeError extends LearnerValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'TutorExchangeError';
  }
}
