import type { CourseReviewContext } from './course-review-contracts.js';
import { groupSharingDigest } from './group-sharing-hash.js';

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );

/** Digest of everything a review's suitability judgement depended on. */
export function courseReviewContextDigest(
  context: CourseReviewContext,
): string {
  return groupSharingDigest(
    canonical({
      levelMin: context.levelMin,
      levelMax: context.levelMax,
      theme: context.theme,
      learnerId: context.learnerId,
      evidenceSnapshotRef: context.evidenceSnapshotRef,
    }),
  );
}
