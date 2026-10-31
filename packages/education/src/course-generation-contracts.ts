import { CourseAuthoringError } from './course-authoring-contracts.js';

export type CourseGenerationStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export const COURSE_GENERATION_STATUSES: readonly CourseGenerationStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
];
export const COURSE_GENERATION_TERMINAL: readonly CourseGenerationStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
];

/** Provider identity, shaped like the ingestion `ProviderIdentity`. */
export interface CourseGeneratorIdentity {
  provider: string;
  model: string;
  version: string;
}

/** What a generator is given: the exact snapshot retained on the job. */
export interface CourseGeneratorRequest {
  tenantId: string;
  courseId: string;
  jobId: string;
  instruction: string;
  /** Immutable snapshot of the base revision; never contains answer keys. */
  material: unknown;
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
  ): Promise<{
    output: unknown;
    completion: 'complete' | 'unknown';
    usage?: Record<string, number>;
    responseModel?: string;
  }>;
}

export interface CourseGenerationLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Closed, validated generation output. Absent members are not proposed. */
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
  status: CourseGenerationStatus;
  provider: string;
  model: string;
  usage: CourseGenerationUsageView;
  errorCode: string | null;
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
