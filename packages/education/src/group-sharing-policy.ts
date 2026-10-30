import {
  type GroupSharingDecision,
  type GroupSharingPolicyV1,
  type GroupSharingWorkFacts,
  validateGroupSharingPolicy,
} from './group-sharing-contracts.js';
import type {
  WorkbookAssessment,
  WorkbookAssistance,
  WorkbookConceptSummary,
} from './workbook-contracts.js';

/** All facets use the same fail-closed eligibility gates. Facts come from owned records. */
export function evaluateGroupSharingPolicy(
  policy: GroupSharingPolicyV1,
  facts: GroupSharingWorkFacts,
): GroupSharingDecision {
  validateGroupSharingPolicy(policy);
  const reasons: string[] = [];
  const captured = Date.parse(facts.capturedAt);
  if (
    !Number.isFinite(captured) ||
    !Number.isFinite(Date.parse(policy.historyFrom)) ||
    captured < Date.parse(policy.historyFrom)
  )
    reasons.push('history');
  if (
    policy.courseIds.mode === 'include' &&
    (!facts.courseId || !policy.courseIds.values.includes(facts.courseId))
  )
    reasons.push('course');
  if (
    policy.subjects.mode === 'include' &&
    (!facts.subject || !policy.subjects.values.includes(facts.subject))
  )
    reasons.push('subject');
  if (policy.parentReviewedOnly && !facts.parentReviewed)
    reasons.push('parent-review');
  const eligible = reasons.length === 0;
  return {
    eligible,
    work: eligible && policy.shareWork,
    media: eligible && policy.shareWork && policy.shareMedia,
    feedback: eligible && policy.shareFeedback,
    progress: eligible && policy.shareProgress,
    reasons,
  };
}
export interface WorkbookEvidenceInput {
  attempt: {
    submissionId: string;
    episodeId: string;
    previousAttemptId: string | null;
    assistance: string;
    capturedAt: Date;
  };
  revisionId: string;
  assessment: WorkbookAssessment;
  confirmed: boolean;
}
/** Owning workbook aggregation shared by family and filtered group projections. */
export function summarizeWorkbookEvidence(
  evidence: WorkbookEvidenceInput[],
): WorkbookConceptSummary[] {
  const summaries = new Map<string, WorkbookConceptSummary>();
  const independentSeen = new Set<string>();
  for (const { attempt, revisionId, assessment, confirmed } of evidence) {
    for (const q of assessment.questions)
      for (const conceptId of q.conceptIds) {
        const key = `${assessment.vocabulary.namespace}:${assessment.vocabulary.version}:${conceptId}`;
        const concept = assessment.vocabulary.concepts.find(
          (c) => c.id === conceptId,
        );
        if (!concept) throw new Error('Unknown workbook concept');
        let summary = summaries.get(key);
        if (!summary) {
          summary = {
            namespace: assessment.vocabulary.namespace,
            version: assessment.vocabulary.version,
            conceptId,
            label: concept.label,
            confirmed: {
              independent: 0,
              assisted: 0,
              unknown: 0,
              correct: 0,
              needsCorrection: 0,
              unassessed: 0,
            },
            provisional: 0,
            episodes: [],
            revisionIds: [],
            cues: [],
            observations: [],
          };
          summaries.set(key, summary);
        }
        if (!summary.episodes.includes(attempt.episodeId))
          summary.episodes.push(attempt.episodeId);
        if (!summary.revisionIds.includes(revisionId))
          summary.revisionIds.push(revisionId);
        const assistance =
          attempt.previousAttemptId && attempt.assistance === 'independent'
            ? 'unknown'
            : (attempt.assistance as WorkbookAssistance);
        summary.observations.push({
          submissionId: attempt.submissionId,
          revisionId,
          questionId: q.id,
          episodeId: attempt.episodeId,
          result: q.result,
          assistance,
          isCorrection: Boolean(attempt.previousAttemptId),
          capturedAt: attempt.capturedAt,
          confirmed,
        });
        if (!confirmed) {
          summary.provisional++;
          continue;
        }
        if (q.result === 'unassessed') {
          summary.confirmed.unassessed++;
          continue;
        }
        const episodeQuestion = `${key}:${attempt.episodeId}:${q.id}`;
        if (
          assistance !== 'independent' ||
          !independentSeen.has(episodeQuestion)
        )
          summary.confirmed[assistance]++;
        if (assistance === 'independent') independentSeen.add(episodeQuestion);
        if (q.result === 'correct') summary.confirmed.correct++;
        else summary.confirmed.needsCorrection++;
        if (
          attempt.previousAttemptId &&
          q.result === 'correct' &&
          !summary.cues.includes('improving on this item')
        )
          summary.cues.push('improving on this item');
      }
  }
  for (const summary of summaries.values()) {
    if (!summary.confirmed.independent)
      summary.cues.push('needs a fresh independent check');
    if (summary.confirmed.needsCorrection) summary.cues.push('needs practice');
    if (!summary.confirmed.correct && !summary.confirmed.needsCorrection)
      summary.cues.push('not enough evidence');
  }
  return [...summaries.values()];
}
