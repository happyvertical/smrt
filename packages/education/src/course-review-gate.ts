import type {
  CourseReferenceGuard,
  ReleaseReviewGate,
} from './course-authoring-contracts.js';
import { courseReviewContextDigest } from './course-review-digest.js';

type Row = Record<string, unknown>;

/**
 * Release gate backed by `CourseReview`. A revision is releasable only when its
 * latest review binds to that exact revision, is still the draft head, carries
 * an intact context digest matching the revision's level target and theme, has
 * no outdated marker, and has no unresolved blocking or human-verification
 * finding. Anything else is not current (fail closed).
 */
export function createReviewBackedReleaseGate(): ReleaseReviewGate {
  return async (executor, request) => {
    const reviews = (await executor.list('course_reviews', {
      tenant_id: request.tenantId,
      course_id: request.courseId,
      revision_id: request.revisionId,
    })) as Row[];
    const latest = reviews.reduce<Row | undefined>(
      (best, row) =>
        !best || Number(row.sequence) > Number(best.sequence) ? row : best,
      undefined,
    );
    if (!latest) return { current: false, reason: 'no-review' };
    const reviewId = String(latest.id);
    const stop = (reason: string) => ({ current: false, reviewId, reason });
    if (
      await executor.get('course_review_outdated_markers', {
        tenant_id: request.tenantId,
        review_id: reviewId,
      })
    )
      return stop('outdated');
    const head = await executor.get('course_draft_heads', {
      tenant_id: request.tenantId,
      course_id: request.courseId,
    });
    if (!head || String(head.head_revision_id) !== request.revisionId)
      return stop('outdated');
    const revision = await executor.get('course_revisions', {
      id: request.revisionId,
      tenant_id: request.tenantId,
      course_id: request.courseId,
    });
    if (!revision) return stop('no-review');
    let context: Row;
    try {
      context = JSON.parse(String(latest.context_json)) as Row;
    } catch {
      return stop('context-mismatch');
    }
    if (
      courseReviewContextDigest(context as never) !==
        String(latest.context_digest) ||
      context.levelMin !== Number(revision.level_min) ||
      context.levelMax !== Number(revision.level_max) ||
      context.theme !== String(revision.theme)
    )
      return stop('context-mismatch');
    const findings = (await executor.list('course_review_findings', {
      tenant_id: request.tenantId,
      review_id: reviewId,
    })) as Row[];
    for (const finding of findings) {
      if (!finding.blocking && !finding.human_verification_required) continue;
      if (
        !(await executor.get('course_finding_resolutions', {
          tenant_id: request.tenantId,
          finding_id: String(finding.id),
        }))
      )
        return stop('unresolved-findings');
    }
    return { current: true, reviewId };
  };
}

/**
 * Reports review and generation rows (and host-supplied variants) that must
 * block discarding a draft. Pass `extra` guards for rows this package does not own.
 */
export function createCourseReferenceGuard(
  extra: readonly CourseReferenceGuard[] = [],
): CourseReferenceGuard {
  return async (executor, request) => {
    const kinds: string[] = [];
    const where = { tenant_id: request.tenantId, course_id: request.courseId };
    if (await executor.get('course_reviews', where)) kinds.push('review');
    if (await executor.get('course_generation_jobs', where))
      kinds.push('generation');
    for (const guard of extra) {
      const result = await guard(executor, request);
      if (result?.referenced !== false)
        kinds.push(...(result?.kinds?.length ? result.kinds : ['reference']));
    }
    return kinds.length
      ? { referenced: true, kinds: [...new Set(kinds)] }
      : { referenced: false };
  };
}
