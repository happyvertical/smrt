/**
 * Pure rubric/answer-key shapes shared by the question models, the authoring
 * service and `Grade`. Importing nothing keeps `submissions.ts` cycle-free.
 */
export interface QuestionRubricCriterion {
  id: string;
  label: string;
  /** Positive maximum points for this criterion. */
  maxPoints: number;
}
export interface QuestionRubric {
  criteria: QuestionRubricCriterion[];
}

const CRITERION_ID = /^[A-Za-z0-9._:-]{1,80}$/;

/** Returns a normalized rubric or throws `Error` naming the first problem. */
export function parseQuestionRubric(value: unknown): QuestionRubric {
  const criteria = (value as QuestionRubric | null)?.criteria;
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 50)
    throw new Error('Rubric requires between one and fifty criteria');
  const seen = new Set<string>();
  return {
    criteria: criteria.map((c) => {
      if (
        !c ||
        typeof c.id !== 'string' ||
        !CRITERION_ID.test(c.id) ||
        seen.has(c.id) ||
        typeof c.label !== 'string' ||
        !c.label.trim() ||
        c.label.length > 500 ||
        !Number.isFinite(c.maxPoints) ||
        c.maxPoints <= 0
      )
        throw new Error('Invalid rubric criterion');
      seen.add(c.id);
      return { id: c.id, label: c.label, maxPoints: c.maxPoints };
    }),
  };
}

/**
 * Validates `Grade.rubricResults` against the exact revision's rubric. A value
 * is a finite number or `{ points: number }`, never above the criterion's
 * maximum. Empty results stay empty (unscored is never zero); results against a
 * revision without a rubric are rejected.
 */
export function validateRubricResults(
  rubricJson: string | null | undefined,
  results: Record<string, unknown>,
): void {
  const entries = Object.entries(results);
  if (!entries.length) return;
  if (!rubricJson)
    throw new Error('Rubric results require a rubric on the question revision');
  const rubric = parseQuestionRubric(JSON.parse(rubricJson));
  const max = new Map(rubric.criteria.map((c) => [c.id, c.maxPoints]));
  for (const [id, raw] of entries) {
    const points =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { points?: unknown }).points
        : raw;
    if (
      !max.has(id) ||
      typeof points !== 'number' ||
      !Number.isFinite(points) ||
      points < 0 ||
      points > (max.get(id) as number)
    )
      throw new Error('Rubric results do not match the question rubric');
  }
}
