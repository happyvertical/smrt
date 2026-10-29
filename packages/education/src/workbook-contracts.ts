/** Explicit help observations; absence never attests independence. */
export type WorkbookAssistance = 'independent' | 'assisted' | 'unknown';
export interface WorkbookConcept {
  id: string;
  label: string;
}
export interface WorkbookAnchor {
  assetId: string;
  sha256: string;
  page: number | null;
  /** Source means the complete original; page means extraction-verified page. */
  grounding?: 'source' | 'page';
  extractionAttemptId?: string;
  /** Normalized x, y, width, height on the retained page. */
  rect: [number, number, number, number];
}
export interface WorkbookQuestion {
  /** Stable within this activity, including occurrence/subpart (e.g. page7:q1:a). */
  id: string;
  prompt: string;
  answer: string;
  result: 'correct' | 'incorrect' | 'partially_correct' | 'unassessed';
  reason:
    | 'none'
    | 'unanswered'
    | 'illegible'
    | 'missing_context'
    | 'unsupported'
    | 'not_present';
  feedback: string;
  points: number | null;
  possiblePoints: number | null;
  anchors: WorkbookAnchor[];
  conceptIds: string[];
  markingCertainty?: 'clear' | 'uncertain' | 'unknown';
  mappingCertainty?: 'clear' | 'uncertain' | 'unknown';
  mappingProvenance?: 'proposed' | 'guardian-reviewed' | 'unknown';
  evidenceLimitations?: string[];
}
export interface WorkbookPreservationState {
  activityId: string;
  submissionId: string;
  intakeItemId: string | null;
  retainedAnalyses: {
    assessmentRevisionId: string;
    analysisAttemptId: string;
    analysisRevision: number | null;
  }[];
}
export interface WorkbookAggregate {
  correct: number;
  incorrect: number;
  partiallyCorrect: number;
  unassessed: number;
  points: number | null;
  possiblePoints: number | null;
  score: number | null;
}
export class WorkbookAssessmentValidationError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'invalid_assessment'
      | 'ungrounded_source'
      | 'ambiguous_proposal' = 'invalid_assessment',
  ) {
    super(message);
    this.name = 'WorkbookAssessmentValidationError';
  }
}
/** Exact arithmetic over validated questions, never a provider's rounded score. */
export function aggregateWorkbookQuestions(
  questions: readonly WorkbookQuestion[],
): WorkbookAggregate {
  const aggregate: WorkbookAggregate = {
    correct: 0,
    incorrect: 0,
    partiallyCorrect: 0,
    unassessed: 0,
    points: null,
    possiblePoints: null,
    score: null,
  };
  const assessed = questions.filter((q) => q.result !== 'unassessed');
  for (const q of questions) {
    if (q.result === 'correct') aggregate.correct++;
    else if (q.result === 'incorrect') aggregate.incorrect++;
    else if (q.result === 'partially_correct') aggregate.partiallyCorrect++;
    else aggregate.unassessed++;
  }
  if (
    assessed.length &&
    assessed.every((q) => q.points !== null && q.possiblePoints !== null)
  ) {
    aggregate.points = assessed.reduce((sum, q) => sum + (q.points ?? 0), 0);
    aggregate.possiblePoints = assessed.reduce(
      (sum, q) => sum + (q.possiblePoints ?? 0),
      0,
    );
    if (
      !Number.isFinite(aggregate.points) ||
      !Number.isFinite(aggregate.possiblePoints)
    )
      throw new WorkbookAssessmentValidationError(
        'Aggregate points exceed finite range',
      );
    aggregate.score =
      aggregate.possiblePoints > 0
        ? aggregate.points / aggregate.possiblePoints
        : null;
  }
  return aggregate;
}
export function workbookAggregateFeedback(
  aggregate: WorkbookAggregate,
): string {
  return `${aggregate.correct} correct; ${aggregate.incorrect} incorrect; ${aggregate.partiallyCorrect} partially correct; ${aggregate.unassessed} unassessed.`;
}
/** Advisory observed structure; never verified source geometry or identity. */
export interface WorkbookObservedLayout {
  version: 1;
  provenance: 'observed';
  sections: {
    id: string;
    label?: string;
    columns: number;
    readingOrder?: 'rows' | 'columns';
    source: { assetId: string; page: number | null };
  }[];
  placements: {
    questionId: string;
    sectionId: string;
    row: number;
    column: number;
    /** Sort parts only when all cell placements specify one; ties use question order. */
    part?: number;
  }[];
}
/** Approximate image observations, not verified OCR boxes or answer identity. */
export interface WorkbookAnswerRegions {
  version: 1;
  provenance: 'observed';
  coordinateSpace: 'display-oriented';
  regions: {
    questionId: string;
    source: { assetId: string; page: 1 };
    rect: [number, number, number, number];
    observationId: string;
  }[];
}
export interface WorkbookAssessment {
  version: 1;
  aggregate?: WorkbookAggregate;
  feedback: string;
  layout?: WorkbookObservedLayout;
  layoutOmission?: 'invalid';
  answerRegions?: WorkbookAnswerRegions;
  answerRegionsOmission?: 'invalid';
  questions: WorkbookQuestion[];
  provenance: {
    provider: string;
    model: string;
    configurationVersion: string;
    rubricVersion: string;
    inputHash: string;
    analysisId: string;
    /** Current interpretation revision, distinct from its extraction-source revision. */
    analysisRevision?: number;
    /** Digest of validated structured proposal arguments, never model-authored. */
    proposalDigest?: string;
    providerVersion?: string;
    sourceAnalysis?: {
      attemptId: string;
      revision: number;
      inputDigest: string;
      outputDigest: string;
      evidenceDigest: string;
    };
    catalogDigest?: string;
    policyVersions?: string[];
  };
  vocabulary: {
    namespace: string;
    version: string;
    concepts: WorkbookConcept[];
  };
}
/** Explicit parent completion is independent of score and feedback visibility. */
export interface WorkbookCompletionState {
  status: 'doing' | 'complete';
  completedAt: Date | null;
}
/** Guardian-only compare-and-set selector for the currently displayed work. */
export interface WorkbookCompletionContext {
  attemptId: string;
  submissionId: string;
  expectedHeadId: string | null;
}
/** Immutable parent decision; a replay may describe an older, no-longer-current attempt. */
export interface WorkbookCompletionDecisionView {
  id: string;
  activityId: string;
  attemptId: string;
  submissionId: string;
  feedbackHeadId: string | null;
  actorUserId: string;
  completedAt: Date;
}
export class WorkbookCompletionConflictError extends Error {
  constructor(
    public readonly code:
      | 'stale_attempt'
      | 'stale_head'
      | 'changed_retry'
      | 'already_complete',
  ) {
    super(`Workbook completion conflict: ${code}`);
    this.name = 'WorkbookCompletionConflictError';
  }
}

export interface WorkbookActivityView {
  currentAttemptId: string | null;
  latestSubmissionId: string | null;
  completion: WorkbookCompletionState;
  filing?: {
    state: 'unfiled' | 'filed' | 'identified';
    workbookId: string | null;
    canonicalActivityId: string | null;
    revisionId: string | null;
  };
  id: string;
  learnerId: string;
  workbookKey: string;
  title: string;
  edition: string;
  pageKey: string;
  pageLabel: string;
  enrollmentId: string;
  lessonId: string;
  reviewRequired: boolean;
  policyVersion: number;
}
export interface WorkbookRevisionView {
  id: string;
  kind: 'ai' | 'guardian';
  supersedesId: string | null;
  createdAt: Date;
  actorUserId: string;
  sourceRevisionId: string | null;
  decisionReason: string;
  assessment: WorkbookAssessment;
}
export interface WorkbookReleaseView {
  id: string;
  revisionId: string;
  createdAt: Date;
  actorUserId: string;
}
export interface WorkbookAttemptView {
  id: string;
  submissionId: string;
  activityId: string;
  previousAttemptId: string | null;
  episodeId: string;
  reviewRequired: boolean;
  policyVersion: number;
  assistance: WorkbookAssistance;
  submission: import('./submission-service.js').SubmissionView;
}
export interface WorkbookTimeline {
  currentAttemptId: string | null;
  latestSubmissionId: string | null;
  completion: WorkbookCompletionState;
  completionContext: WorkbookCompletionContext | null;
  activity: WorkbookActivityView;
  attempts: (WorkbookAttemptView & {
    revisions: WorkbookRevisionView[];
    releases: WorkbookReleaseView[];
    deliveries: WorkbookReleaseView[];
    headId: string | null;
    completionDecision: WorkbookCompletionDecisionView | null;
  })[];
  nextCursor: string | null;
}
export interface WorkbookConceptSummary {
  namespace: string;
  version: string;
  conceptId: string;
  label: string;
  confirmed: {
    independent: number;
    assisted: number;
    unknown: number;
    correct: number;
    needsCorrection: number;
    unassessed: number;
  };
  provisional: number;
  episodes: string[];
  revisionIds: string[];
  cues: string[];
  observations: {
    submissionId: string;
    revisionId: string;
    questionId: string;
    episodeId: string;
    result: WorkbookQuestion['result'];
    assistance: WorkbookAssistance;
    isCorrection: boolean;
    capturedAt: Date;
    confirmed: boolean;
  }[];
}

function text(
  value: unknown,
  label: string,
  max = 10000,
): asserts value is string {
  if (typeof value !== 'string' || value.length > max)
    throw new WorkbookAssessmentValidationError(`Invalid ${label}`);
}
/** Validate at every external/persistence boundary; unknown enum values fail closed. */
export function validateWorkbookAssessment(value: WorkbookAssessment): void {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.questions) ||
    !value.questions.length ||
    value.questions.length > 200
  )
    throw new WorkbookAssessmentValidationError('Invalid workbook assessment');
  text(value.feedback, 'feedback');
  if (!value.provenance || !value.vocabulary)
    throw new WorkbookAssessmentValidationError(
      'Missing assessment provenance',
    );
  for (const key of [
    'provider',
    'model',
    'configurationVersion',
    'rubricVersion',
    'inputHash',
    'analysisId',
  ] as const) {
    text(value.provenance[key], key, 500);
    if (!value.provenance[key].trim())
      throw new WorkbookAssessmentValidationError(`Missing ${key}`);
  }
  if (
    value.provenance.analysisRevision !== undefined &&
    (!Number.isSafeInteger(value.provenance.analysisRevision) ||
      value.provenance.analysisRevision < 1)
  )
    throw new WorkbookAssessmentValidationError(
      'Invalid interpretation revision',
    );
  if (!/^[a-f0-9]{64}$/.test(value.provenance.inputHash))
    throw new WorkbookAssessmentValidationError('Invalid input hash');
  text(value.vocabulary.namespace, 'concept namespace', 200);
  text(value.vocabulary.version, 'concept version', 200);
  if (
    !value.vocabulary.namespace.trim() ||
    !value.vocabulary.version.trim() ||
    !Array.isArray(value.vocabulary.concepts) ||
    value.vocabulary.concepts.length > 100
  )
    throw new WorkbookAssessmentValidationError('Invalid concept vocabulary');
  const concepts = new Set<string>();
  for (const concept of value.vocabulary.concepts) {
    text(concept.id, 'concept id', 200);
    text(concept.label, 'concept label', 500);
    if (!concept.id.trim() || !concept.label.trim() || concepts.has(concept.id))
      throw new WorkbookAssessmentValidationError('Duplicate or empty concept');
    concepts.add(concept.id);
  }
  const ids = new Set<string>();
  for (const q of value.questions) {
    if (
      q.markingCertainty !== undefined &&
      !['clear', 'uncertain', 'unknown'].includes(q.markingCertainty)
    )
      throw new WorkbookAssessmentValidationError('Invalid marking certainty');
    if (
      q.mappingCertainty !== undefined &&
      !['clear', 'uncertain', 'unknown'].includes(q.mappingCertainty)
    )
      throw new WorkbookAssessmentValidationError('Invalid mapping certainty');
    if (
      q.mappingProvenance !== undefined &&
      !['proposed', 'guardian-reviewed', 'unknown'].includes(
        q.mappingProvenance,
      )
    )
      throw new WorkbookAssessmentValidationError('Invalid mapping provenance');
    if (
      q.evidenceLimitations !== undefined &&
      (!Array.isArray(q.evidenceLimitations) ||
        q.evidenceLimitations.length > 20 ||
        q.evidenceLimitations.some(
          (v) => typeof v !== 'string' || v.length > 500,
        ))
    )
      throw new WorkbookAssessmentValidationError(
        'Invalid evidence limitations',
      );
    text(q.id, 'question id', 200);
    text(q.prompt, 'prompt');
    text(q.answer, 'answer');
    text(q.feedback, 'question feedback');
    if (!q.id.trim() || ids.has(q.id))
      throw new WorkbookAssessmentValidationError(
        'Duplicate or empty question id',
      );
    ids.add(q.id);
    if (
      !['correct', 'incorrect', 'partially_correct', 'unassessed'].includes(
        q.result,
      ) ||
      ![
        'none',
        'unanswered',
        'illegible',
        'missing_context',
        'unsupported',
        'not_present',
      ].includes(q.reason)
    )
      throw new WorkbookAssessmentValidationError('Invalid question result');
    if (q.markingCertainty === 'uncertain' && q.result !== 'unassessed')
      throw new WorkbookAssessmentValidationError(
        'Uncertain marking must remain unassessed',
      );
    if (
      (q.result === 'unassessed' && q.reason === 'none') ||
      ([
        'unanswered',
        'illegible',
        'missing_context',
        'unsupported',
        'not_present',
      ].includes(q.reason) &&
        q.result !== 'unassessed')
    )
      throw new WorkbookAssessmentValidationError(
        'Uncertain evidence must remain unassessed',
      );
    if (
      q.result === 'unassessed' &&
      (q.points !== null || q.possiblePoints !== null)
    )
      throw new WorkbookAssessmentValidationError('Unassessed is not zero');
    if (
      (q.points === null) !== (q.possiblePoints === null) ||
      (q.points !== null &&
        (!Number.isFinite(q.points) ||
          !Number.isFinite(q.possiblePoints) ||
          q.points < 0 ||
          q.possiblePoints! <= 0 ||
          q.points > q.possiblePoints!))
    )
      throw new WorkbookAssessmentValidationError('Invalid question points');
    if (
      q.points !== null &&
      q.possiblePoints !== null &&
      ((q.result === 'correct' && q.points !== q.possiblePoints) ||
        (q.result === 'incorrect' && q.points !== 0) ||
        (q.result === 'partially_correct' &&
          (q.points <= 0 || q.points >= q.possiblePoints)))
    )
      throw new WorkbookAssessmentValidationError(
        'Question result contradicts points',
      );
    if (
      !Array.isArray(q.conceptIds) ||
      q.conceptIds.some((id) => !concepts.has(id)) ||
      new Set(q.conceptIds).size !== q.conceptIds.length
    )
      throw new WorkbookAssessmentValidationError('Unknown concept mapping');
    if (!Array.isArray(q.anchors) || !q.anchors.length || q.anchors.length > 20)
      throw new WorkbookAssessmentValidationError(
        'Question requires retained source anchors',
      );
    for (const a of q.anchors) {
      text(a.assetId, 'source asset', 64);
      if (a.grounding && JSON.stringify(a.rect) !== '[0,0,1,1]')
        throw new WorkbookAssessmentValidationError(
          'Source/page grounding cannot claim an unverified question region',
          'ungrounded_source',
        );
      if (
        !a.assetId ||
        !/^[a-f0-9]{64}$/.test(a.sha256) ||
        (a.page === null
          ? a.grounding !== 'source'
          : !Number.isSafeInteger(a.page) || a.page < 1) ||
        (a.grounding !== undefined &&
          !['source', 'page'].includes(a.grounding)) ||
        !Array.isArray(a.rect) ||
        a.rect.length !== 4 ||
        a.rect.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
        a.rect[2] <= 0 ||
        a.rect[3] <= 0 ||
        a.rect[0] + a.rect[2] > 1 ||
        a.rect[1] + a.rect[3] > 1
      )
        throw new WorkbookAssessmentValidationError('Invalid source anchor');
    }
  }
  if (value.aggregate) {
    const expected = aggregateWorkbookQuestions(value.questions);
    if (
      (Object.keys(expected) as (keyof WorkbookAggregate)[]).some(
        (key) => value.aggregate?.[key] !== expected[key],
      )
    )
      throw new WorkbookAssessmentValidationError(
        'Assessment aggregate contradicts questions',
      );
  }
  if (JSON.stringify(value).length > 1024 * 1024)
    throw new WorkbookAssessmentValidationError(
      'Assessment exceeds size limit',
    );
}
/** A deliberately small curated vocabulary; hosts may supply a different one. */
export const WORKBOOK_MATH_VOCABULARY: WorkbookAssessment['vocabulary'] = {
  namespace: 'education.workbook.math',
  version: '1',
  concepts: [
    { id: 'math.addition', label: 'Addition' },
    { id: 'math.subtraction', label: 'Subtraction' },
    { id: 'math.place-value', label: 'Place value' },
  ],
};
