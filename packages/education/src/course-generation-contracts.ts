import { CourseAuthoringError } from './course-authoring-contracts.js';
import type {
  InterestTheme,
  InterestThemeInput,
} from './learner-interest-theme.js';
import type {
  QuestionAnswerKey,
  QuestionChoice,
  QuestionResponseType,
  QuestionRubric,
  QuestionSubpart,
} from './question-contracts.js';

export type CourseGenerationStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'refused';
export const COURSE_GENERATION_STATUSES: readonly CourseGenerationStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'refused',
];
export const COURSE_GENERATION_TERMINAL: readonly CourseGenerationStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'refused',
];

/** Longest recorded refusal category and explanation, in characters. */
export const MAX_REFUSAL_CATEGORY_LENGTH = 100;
export const MAX_REFUSAL_EXPLANATION_LENGTH = 2000;

/** What a provider said when it declined to produce the requested material. */
export interface CourseGenerationRefusalDetail {
  /** Provider-neutral label such as `safety` or `policy`; untrusted, bounded. */
  category?: string;
  /** The provider's own explanation; untrusted, bounded, never rendered as HTML. */
  explanation?: string;
}

/**
 * A model refusal, as a typed outcome rather than a provider error. A generator
 * may throw it, or return `{ refusal }`. The service records `refused` with the
 * usage the refusal carries, never retries it and never proposes content.
 */
export class CourseGenerationRefusal extends Error {
  readonly category?: string;
  readonly explanation?: string;
  readonly usage?: Record<string, number>;
  readonly responseModel?: string;
  constructor(
    detail: CourseGenerationRefusalDetail & {
      usage?: Record<string, number>;
      responseModel?: string;
    } = {},
  ) {
    super('The provider refused to generate the requested material.');
    this.name = 'CourseGenerationRefusal';
    this.category = detail.category;
    this.explanation = detail.explanation;
    this.usage = detail.usage;
    this.responseModel = detail.responseModel;
  }
}

/** The returned form of a refusal; `refusal` is never part of proposal `output`. */
export interface CourseGeneratorRefusalResult {
  refusal: CourseGenerationRefusalDetail;
  usage?: Record<string, number>;
  responseModel?: string;
}

/** Provider identity, shaped like the ingestion `ProviderIdentity`. */
export interface CourseGeneratorIdentity {
  provider: string;
  model: string;
  version: string;
}

/**
 * What a generation request produces: the whole course (today's behaviour and
 * the default) or exactly one lesson with its worksheet, answer key and themed
 * explanations.
 */
export type CourseGenerationTarget = 'course' | 'lesson';
export const COURSE_GENERATION_TARGETS: readonly CourseGenerationTarget[] = [
  'course',
  'lesson',
];

/** Where the theme used for a request came from. */
export type CourseGenerationThemeSource = 'override' | 'saved' | 'none';

/** Longest structured field (subject, category, area), in characters. */
export const MAX_GENERATION_BRIEF_FIELD_CHARS = 200;
/** Longest objective statement, in characters. */
export const MAX_GENERATION_OBJECTIVE_CHARS = 1000;
/** Highest grade level a structured request may name (0 is kindergarten). */
export const MAX_GENERATION_GRADE = 12;

/**
 * Structured fields a host may carry on a generation request next to the free
 * `instruction`. All are optional except that a `lesson` target needs an
 * objective (from `objective` or, failing that, `area`). Untrusted text: it is
 * bounded, stored and sent to the provider as data, never as authority.
 */
export interface CourseGenerationBriefInput {
  /** Defaults to `course`. */
  target?: CourseGenerationTarget;
  subject?: string;
  category?: string;
  /** The specific skill to learn, for example "multiplying by tens". */
  area?: string;
  /** Whole grade level, 0-12. */
  grade?: number;
  /**
   * The curriculum's objective for a lesson. The theme never changes it; it is
   * carried verbatim in the generation brief and the proposal.
   */
  objective?: string;
  /** Stable `LearningObjective` id the generated questions are linked to. */
  learningObjectiveId?: string;
  /** The learner the request is for; needed to fall back to their saved theme. */
  learnerId?: string;
  /**
   * Per-request theme. When present it wins for this request only; it never
   * changes the learner's saved preference.
   */
  theme?: InterestThemeInput | null;
}

/** The resolved, stored brief: what the provider is asked and what review shows. */
export interface CourseGenerationBrief {
  target: CourseGenerationTarget;
  subject: string;
  category: string;
  area: string;
  grade: number | null;
  objective: string;
  learningObjectiveId: string | null;
  learnerId: string | null;
  /** The theme used for story and examples only, or null when there was none. */
  theme: InterestTheme | null;
  /** `override` (this request), `saved` (the learner's preference) or `none`. */
  themeSource: CourseGenerationThemeSource;
}

/** What a generator is given: the exact snapshot retained on the job. */
export interface CourseGeneratorRequest {
  tenantId: string;
  courseId: string;
  jobId: string;
  instruction: string;
  /** Immutable snapshot of the base revision; never contains answer keys. */
  material: unknown;
  /**
   * The resolved structured brief, when the request carried one. For a `lesson`
   * target the generator must return exactly one lesson that teaches
   * `brief.objective`; the theme may change only its story and examples.
   */
  brief?: CourseGenerationBrief;
}

/**
 * Host-injected generation port. It matches the ingestion `ProposalGenerator`
 * result contract (untrusted `output`, optional `usage` and `responseModel`).
 * The service never selects a provider; the output is validated against the
 * closed proposal schema before anything is written.
 */
export interface CourseMaterialGenerator {
  identity: CourseGeneratorIdentity;
  generate(
    request: CourseGeneratorRequest,
    options: { signal: AbortSignal; maxOutputBytes: number },
  ): Promise<
    | {
        output: unknown;
        completion: 'complete' | 'unknown';
        usage?: Record<string, number>;
        responseModel?: string;
      }
    | CourseGeneratorRefusalResult
  >;
}

export interface CourseGenerationLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Closed, validated generation output. Absent members are not proposed. */
/** One generated question (lesson target only); the answer key is required. */
export interface CourseGenerationProposalQuestion {
  prompt: string;
  responseType: QuestionResponseType;
  choices?: QuestionChoice[];
  subparts?: QuestionSubpart[];
  answerKey: QuestionAnswerKey;
  rubric?: QuestionRubric;
  pointsPossible?: number;
}
export interface CourseGenerationProposalLesson {
  /** Existing lesson to propose changes to; omitted for a new lesson. */
  lessonKey?: string;
  /** New lessons only. */
  sectionKey?: string;
  sectionTitle?: string;
  title?: string;
  body?: string;
  estimatedMinutes?: number;
  difficulty?: number;
  /** Lesson target only. Always equals the brief's objective once validated. */
  objective?: string;
  /** Lesson target only: the worksheet. Answer keys never reach a learner view. */
  questions?: CourseGenerationProposalQuestion[];
}
export interface CourseGenerationProposal {
  course: { summary?: string; subject?: string; objectives?: string[] };
  lessons: CourseGenerationProposalLesson[];
  rationale: string;
}

export type CourseProposalFieldStatus =
  | 'added'
  | 'filled'
  | 'conflict'
  | 'unchanged';
export type CourseProposalDecisionKind = 'accepted' | 'rejected';
/** One field of the supplied-versus-proposed comparison. */
export interface CourseProposalFieldView {
  /** `course.summary`, `lesson:<key>.body` or `new-lesson:<n>`. */
  field: string;
  status: CourseProposalFieldStatus;
  /** Supplied value when the proposal was made; null when there was none. */
  supplied: unknown;
  proposed: unknown;
  /** Value in the current draft head; differs from `supplied` once edited. */
  current: unknown;
  /** A conflict stays undecided until a guardian or delegate decides it. */
  decision: CourseProposalDecisionKind | null;
}
export interface CourseProposalView {
  proposalId: string;
  jobId: string;
  courseId: string;
  baseRevisionId: string;
  /** The new draft revision holding only additions and fills. */
  resultRevisionId: string;
  rationale: string;
  /** The brief the proposal answered: objective, theme and where the theme came from. */
  brief: CourseGenerationBrief | null;
  fields: CourseProposalFieldView[];
}

export interface CourseGenerationUsageView {
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  costCurrency: string | null;
  raw: Record<string, number>;
}
export interface CourseGenerationEventView {
  sequence: number;
  status: CourseGenerationStatus;
  provider: string;
  model: string;
  version: string;
  responseModel: string;
  usage: CourseGenerationUsageView;
  errorCode: string | null;
  detail: string;
  proposalId: string | null;
  resultRevisionId: string | null;
  actorUserId: string;
  delegatingGuardianUserId: string | null;
  delegationId: string | null;
  recordedAt: string;
}
export interface CourseGenerationView {
  jobId: string;
  courseId: string;
  baseRevisionId: string;
  requestKey: string;
  instruction: string;
  /** The resolved structured brief; null for a plain instruction-only request. */
  brief: CourseGenerationBrief | null;
  status: CourseGenerationStatus;
  provider: string;
  model: string;
  usage: CourseGenerationUsageView;
  errorCode: string | null;
  /** Set only when `status` is `refused`. */
  refusal: { category: string | null; explanation: string } | null;
  proposalId: string | null;
  resultRevisionId: string | null;
  requestedByUserId: string;
  delegatingGuardianUserId: string | null;
  delegationId: string | null;
  events: CourseGenerationEventView[];
}

export class CourseGeneratorNotConfiguredError extends CourseAuthoringError {
  constructor() {
    super(
      'generator-not-configured',
      'No course material generator is configured.',
    );
  }
}
export class CourseGenerationNotFoundError extends CourseAuthoringError {
  constructor() {
    super('generation-not-found', 'Generation job was not found.');
  }
}
export class CourseGenerationInProgressError extends CourseAuthoringError {
  constructor() {
    super('generation-in-progress', 'Generation is already running.');
  }
}
export class CourseGenerationOutputError extends CourseAuthoringError {
  constructor(readonly path: string) {
    super(
      'invalid-generation-output',
      'Generated output did not match the closed proposal schema.',
    );
  }
}
export class CourseProposalNotFoundError extends CourseAuthoringError {
  constructor() {
    super('proposal-not-found', 'Proposal was not found.');
  }
}
export class CourseProposalFieldError extends CourseAuthoringError {
  constructor(readonly fields: readonly string[]) {
    super(
      'proposal-field-not-decidable',
      'Only undecided conflicting proposal fields can be decided.',
    );
  }
}

/** The structured brief was malformed or inconsistent with its target. */
export class CourseGenerationBriefError extends CourseAuthoringError {
  constructor(readonly field: string) {
    super('invalid-generation-brief', 'The generation brief is not valid.');
  }
}
