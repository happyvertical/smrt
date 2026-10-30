import { groupSharingDigest } from './group-sharing-hash.js';
import type {
  GuardianQuestionItem,
  GuardianWorksheetBundle,
  LearnerQuestionItem,
  LearnerWorksheetBundle,
  LessonLayoutParams,
  LessonQuestionRefInput,
  QuestionRevisionView,
} from './question-contracts.js';

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

/**
 * Deterministic id of one worksheet layout: the ordered question revisions with
 * their placement plus the layout params. Printable and online renders of the
 * same inputs share it, so a later scan can be matched to the exact revisions.
 */
export function worksheetVersionId(
  refs: readonly LessonQuestionRefInput[],
  layoutParams: LessonLayoutParams = {},
): string {
  return `wsv1-${groupSharingDigest(
    canonical({
      refs: refs.map((r) => [
        r.questionRevisionId,
        r.section ?? '',
        r.column ?? 1,
      ]),
      layoutParams,
    }),
  ).slice(0, 40)}`;
}

function learnerItem(
  ref: LessonQuestionRefInput,
  ordinal: number,
  revision: QuestionRevisionView,
): LearnerQuestionItem {
  // An allowlist, never a spread: keys, rubrics and provenance cannot leak.
  return {
    ordinal,
    questionId: revision.questionId,
    questionRevisionId: revision.id,
    section: ref.section ?? '',
    column: ref.column ?? 1,
    anchor: ref.anchor ?? null,
    prompt: revision.prompt,
    responseType: revision.responseType,
    choices: revision.choices,
    subparts: revision.subparts,
    media: revision.media,
    pointsPossible: revision.pointsPossible,
  };
}

export interface WorksheetRenderInput {
  lessonRevisionId: string;
  refs: readonly LessonQuestionRefInput[];
  layoutParams?: LessonLayoutParams;
  /** The pinned revisions, by id. Every ref must resolve. */
  revisions: ReadonlyMap<string, QuestionRevisionView>;
}

function resolve(input: WorksheetRenderInput) {
  return input.refs.map((ref, index) => {
    const revision = input.revisions.get(ref.questionRevisionId);
    if (!revision) throw new Error('Worksheet references a missing question');
    return { ref, ordinal: index + 1, revision };
  });
}

/** Render input for learners (printable or online); answer keys are excluded by type. */
export function buildLearnerWorksheet(
  input: WorksheetRenderInput,
): LearnerWorksheetBundle {
  const layoutParams = input.layoutParams ?? {};
  return {
    audience: 'learner',
    worksheetVersionId: worksheetVersionId(input.refs, layoutParams),
    lessonRevisionId: input.lessonRevisionId,
    layoutParams,
    items: resolve(input).map((r) => learnerItem(r.ref, r.ordinal, r.revision)),
  };
}

/** Guardian/author bundle: the same items plus keys, rubrics and provenance. */
export function buildGuardianWorksheet(
  input: WorksheetRenderInput,
): GuardianWorksheetBundle {
  const layoutParams = input.layoutParams ?? {};
  return {
    audience: 'guardian',
    worksheetVersionId: worksheetVersionId(input.refs, layoutParams),
    lessonRevisionId: input.lessonRevisionId,
    layoutParams,
    items: resolve(input).map(
      (r): GuardianQuestionItem => ({
        ...learnerItem(r.ref, r.ordinal, r.revision),
        answerKey: r.revision.answerKey,
        rubric: r.revision.rubric,
        fieldProvenance: r.revision.fieldProvenance,
      }),
    ),
  };
}
