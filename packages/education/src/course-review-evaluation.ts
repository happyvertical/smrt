import {
  COURSE_REVIEW_CONCERNS,
  type CourseReviewConcern,
} from './course-review-contracts.js';

/** One piece of material a reviewer is asked about. */
export interface ReviewFixtureMaterial {
  /** Stable reference a finding must use, for example `lesson:fractions-2`. */
  ref: string;
  kind: 'lesson' | 'question';
  title: string;
  text: string;
  answerKey?: string;
  prerequisites?: string[];
}
export interface SeededFlaw {
  ref: string;
  concern: CourseReviewConcern;
  note: string;
}
export interface ReviewFixtureCase {
  id: string;
  levelMin: number;
  levelMax: number;
  /** Everything the reviewer may look at for this case. */
  materials: ReviewFixtureMaterial[];
  /** Empty for suitable material, where any finding is a false alarm. */
  seeded: SeededFlaw[];
}
export interface ReviewerFinding {
  ref: string;
  concern: CourseReviewConcern;
}
/** A supplied reviewer, for example a stub in tests or a live model in a host eval. */
export type FixtureReviewer = (
  input: Pick<ReviewFixtureCase, 'id' | 'levelMin' | 'levelMax' | 'materials'>,
) => ReviewerFinding[] | Promise<ReviewerFinding[]>;

export interface ReviewEvaluationCaseResult {
  id: string;
  suitable: boolean;
  truePositives: number;
  falsePositives: number;
  missed: SeededFlaw[];
}
export interface ReviewEvaluationReport {
  cases: ReviewEvaluationCaseResult[];
  truePositives: number;
  falsePositives: number;
  missed: number;
  /** tp / (tp + fp); null when the reviewer raised nothing. */
  precision: number | null;
  /** tp / seeded; null when nothing was seeded. */
  recall: number | null;
  /** Suitable cases with at least one finding / suitable cases; null with none. */
  falseAlarmRate: number | null;
  /** Findings per category that matched a seeded flaw. */
  byConcern: Partial<
    Record<CourseReviewConcern, { found: number; seeded: number }>
  >;
}

function concernEntry(
  table: ReviewEvaluationReport['byConcern'],
  concern: CourseReviewConcern,
) {
  const existing = table[concern];
  if (existing) return existing;
  const created = { found: 0, seeded: 0 };
  table[concern] = created;
  return created;
}

/**
 * Scores a reviewer against seeded flaws and suitable material. A finding is a
 * true positive when it names a seeded flaw's material reference and concern
 * (each flaw matches once); every other finding is a false alarm. The report
 * has per-category and aggregate rates only: no score for any material.
 */
export async function evaluateReviewer(
  cases: readonly ReviewFixtureCase[],
  reviewer: FixtureReviewer,
): Promise<ReviewEvaluationReport> {
  const results: ReviewEvaluationCaseResult[] = [];
  const byConcern: ReviewEvaluationReport['byConcern'] = {};
  let seededTotal = 0;
  let suitableCases = 0;
  let suitableWithFindings = 0;
  for (const c of cases) {
    const refs = new Set(c.materials.map((m) => m.ref));
    const findings = await reviewer({
      id: c.id,
      levelMin: c.levelMin,
      levelMax: c.levelMax,
      materials: c.materials,
    });
    const open = [...c.seeded];
    let tp = 0;
    let fp = 0;
    for (const f of findings) {
      const valid =
        refs.has(f.ref) && COURSE_REVIEW_CONCERNS.includes(f.concern);
      const index = valid
        ? open.findIndex((s) => s.ref === f.ref && s.concern === f.concern)
        : -1;
      if (index >= 0) {
        const [hit] = open.splice(index, 1);
        tp++;
        concernEntry(byConcern, hit.concern).found++;
      } else fp++;
    }
    for (const s of c.seeded) {
      concernEntry(byConcern, s.concern).seeded++;
    }
    seededTotal += c.seeded.length;
    const suitable = c.seeded.length === 0;
    if (suitable) {
      suitableCases++;
      if (findings.length) suitableWithFindings++;
    }
    results.push({
      id: c.id,
      suitable,
      truePositives: tp,
      falsePositives: fp,
      missed: open,
    });
  }
  const truePositives = results.reduce((n, r) => n + r.truePositives, 0);
  const falsePositives = results.reduce((n, r) => n + r.falsePositives, 0);
  return {
    cases: results,
    truePositives,
    falsePositives,
    missed: results.reduce((n, r) => n + r.missed.length, 0),
    precision:
      truePositives + falsePositives
        ? truePositives / (truePositives + falsePositives)
        : null,
    recall: seededTotal ? truePositives / seededTotal : null,
    falseAlarmRate: suitableCases ? suitableWithFindings / suitableCases : null,
    byConcern,
  };
}
