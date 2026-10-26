/** Explicit help observations; absence never attests independence. */
export type WorkbookAssistance = 'independent' | 'assisted' | 'unknown';
export interface WorkbookConcept {
  id: string;
  label: string;
}
export interface WorkbookAnchor {
  assetId: string;
  sha256: string;
  page: number;
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
export interface WorkbookAssessment {
  version: 1;
  feedback: string;
  questions: WorkbookQuestion[];
  provenance: {
    provider: string;
    model: string;
    configurationVersion: string;
    rubricVersion: string;
    inputHash: string;
    analysisId: string;
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
export interface WorkbookActivityView {
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
  activity: WorkbookActivityView;
  attempts: (WorkbookAttemptView & {
    revisions: WorkbookRevisionView[];
    releases: WorkbookReleaseView[];
    deliveries: WorkbookReleaseView[];
    headId: string | null;
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
    throw new Error(`Invalid ${label}`);
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
    throw new Error('Invalid workbook assessment');
  text(value.feedback, 'feedback');
  if (!value.provenance || !value.vocabulary)
    throw new Error('Missing assessment provenance');
  for (const key of [
    'provider',
    'model',
    'configurationVersion',
    'rubricVersion',
    'inputHash',
    'analysisId',
  ] as const) {
    text(value.provenance[key], key, 500);
    if (!value.provenance[key].trim()) throw new Error(`Missing ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(value.provenance.inputHash))
    throw new Error('Invalid input hash');
  text(value.vocabulary.namespace, 'concept namespace', 200);
  text(value.vocabulary.version, 'concept version', 200);
  if (
    !value.vocabulary.namespace.trim() ||
    !value.vocabulary.version.trim() ||
    !Array.isArray(value.vocabulary.concepts) ||
    value.vocabulary.concepts.length > 100
  )
    throw new Error('Invalid concept vocabulary');
  const concepts = new Set<string>();
  for (const concept of value.vocabulary.concepts) {
    text(concept.id, 'concept id', 200);
    text(concept.label, 'concept label', 500);
    if (!concept.id.trim() || !concept.label.trim() || concepts.has(concept.id))
      throw new Error('Duplicate or empty concept');
    concepts.add(concept.id);
  }
  const ids = new Set<string>();
  for (const q of value.questions) {
    if (
      q.markingCertainty !== undefined &&
      !['clear', 'uncertain', 'unknown'].includes(q.markingCertainty)
    )
      throw new Error('Invalid marking certainty');
    if (
      q.mappingCertainty !== undefined &&
      !['clear', 'uncertain', 'unknown'].includes(q.mappingCertainty)
    )
      throw new Error('Invalid mapping certainty');
    if (
      q.mappingProvenance !== undefined &&
      !['proposed', 'guardian-reviewed', 'unknown'].includes(
        q.mappingProvenance,
      )
    )
      throw new Error('Invalid mapping provenance');
    if (
      q.evidenceLimitations !== undefined &&
      (!Array.isArray(q.evidenceLimitations) ||
        q.evidenceLimitations.length > 20 ||
        q.evidenceLimitations.some(
          (v) => typeof v !== 'string' || v.length > 500,
        ))
    )
      throw new Error('Invalid evidence limitations');
    text(q.id, 'question id', 200);
    text(q.prompt, 'prompt');
    text(q.answer, 'answer');
    text(q.feedback, 'question feedback');
    if (!q.id.trim() || ids.has(q.id))
      throw new Error('Duplicate or empty question id');
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
      throw new Error('Invalid question result');
    if (q.markingCertainty === 'uncertain' && q.result !== 'unassessed')
      throw new Error('Uncertain marking must remain unassessed');
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
      throw new Error('Uncertain evidence must remain unassessed');
    if (
      q.result === 'unassessed' &&
      (q.points !== null || q.possiblePoints !== null)
    )
      throw new Error('Unassessed is not zero');
    if (
      (q.points === null) !== (q.possiblePoints === null) ||
      (q.points !== null &&
        (!Number.isFinite(q.points) ||
          !Number.isFinite(q.possiblePoints) ||
          q.points < 0 ||
          q.possiblePoints! <= 0 ||
          q.points > q.possiblePoints!))
    )
      throw new Error('Invalid question points');
    if (
      !Array.isArray(q.conceptIds) ||
      q.conceptIds.some((id) => !concepts.has(id)) ||
      new Set(q.conceptIds).size !== q.conceptIds.length
    )
      throw new Error('Unknown concept mapping');
    if (!Array.isArray(q.anchors) || !q.anchors.length || q.anchors.length > 20)
      throw new Error('Question requires retained source anchors');
    for (const a of q.anchors) {
      text(a.assetId, 'source asset', 64);
      if (
        !a.assetId ||
        !/^[a-f0-9]{64}$/.test(a.sha256) ||
        !Number.isSafeInteger(a.page) ||
        a.page < 1 ||
        !Array.isArray(a.rect) ||
        a.rect.length !== 4 ||
        a.rect.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
        a.rect[2] <= 0 ||
        a.rect[3] <= 0 ||
        a.rect[0] + a.rect[2] > 1 ||
        a.rect[1] + a.rect[3] > 1
      )
        throw new Error('Invalid source anchor');
    }
  }
  if (JSON.stringify(value).length > 1024 * 1024)
    throw new Error('Assessment exceeds size limit');
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
