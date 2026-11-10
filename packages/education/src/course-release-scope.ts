import type { DatabaseInterface } from '@happyvertical/sql';
import { LessonProgressCollection } from './collections.js';
import type { EffectiveLessonView } from './course-authoring-contracts.js';
import {
  EnrollmentReleasePinCollection,
  ReleasedLessonCollection,
} from './course-authoring-models.js';

/**
 * The single rule for which immutable lesson rows apply to a pinned enrollment.
 * Callers authorize the actor and enrollment first; every read here is bound to
 * the supplied executor (so it joins the caller's transaction) and the exact
 * tenant and enrollment. `getEnrollmentRelease` and the learner projections both
 * call this, so the two can never disagree.
 */
export type EnrollmentLessonSelection = Readonly<{
  /** The release the enrollment currently follows. */
  currentReleaseId: string;
  /** Every release the enrollment has been pinned to, oldest first. */
  lineage: ReadonlyArray<string>;
  /** Effective lessons, sorted by stable lessonKey. */
  lessons: EffectiveLessonView[];
  /** The materialized Course row of each release that contributes a lesson. */
  releaseCourseIds: ReadonlyMap<string, string>;
  /** Stable lessonKey to lesson row id, per release in the lineage. */
  keysByRelease: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Learner ids recorded on the pins (a mismatch with the enrollment fails closed). */
  pinLearnerIds: ReadonlySet<string>;
}>;

/**
 * Started lessons stay on the immutable row they were started on, in every
 * release the enrollment has followed; unstarted lessons follow the current
 * release. Returns null for an enrollment that has never been pinned.
 */
export async function resolveEnrollmentLessons(
  db: DatabaseInterface,
  tenantId: string,
  enrollmentId: string,
): Promise<EnrollmentLessonSelection | null> {
  const pins = (
    await (
      await EnrollmentReleasePinCollection.create({ db })
    ).list({ where: { tenantId, enrollmentId }, limit: 100000 })
  ).sort((a, b) => a.sequence - b.sequence);
  const current = pins.at(-1);
  if (!current) return null;
  const currentReleaseId = current.releaseId;
  const lineage = [...new Set(pins.map((p) => p.releaseId))];
  const releasedLessons = await ReleasedLessonCollection.create({ db });
  const keysByRelease = new Map<string, Map<string, string>>();
  for (const releaseId of lineage) {
    const rows = await releasedLessons.list({
      where: { tenantId, releaseId },
      limit: 100000,
    });
    keysByRelease.set(
      releaseId,
      new Map(rows.map((row) => [row.lessonKey, row.lessonId])),
    );
  }
  const progress = await (await LessonProgressCollection.create({ db })).list({
    where: { tenantId, enrollmentId },
    limit: 1000000,
  });
  const startedIds = new Set(
    progress
      .filter((row) => row.status !== 'not_started' || Number(row.attempts) > 0)
      .map((row) => row.lessonId),
  );
  const result = new Map<string, EffectiveLessonView>();
  for (const [lessonKey, lessonId] of keysByRelease.get(currentReleaseId) ?? [])
    result.set(lessonKey, {
      lessonKey,
      lessonId,
      releaseId: currentReleaseId,
      pinnedToOlderRelease: false,
    });
  // Oldest first so the newest release in which a lesson was started wins.
  for (const releaseId of lineage.filter((id) => id !== currentReleaseId))
    for (const [lessonKey, lessonId] of keysByRelease.get(releaseId) ?? [])
      if (startedIds.has(lessonId))
        result.set(lessonKey, {
          lessonKey,
          lessonId,
          releaseId,
          pinnedToOlderRelease: true,
        });
  const lessons = [...result.values()].sort((a, b) =>
    a.lessonKey.localeCompare(b.lessonKey),
  );
  const releaseCourseIds = new Map<string, string>();
  for (const releaseId of new Set([
    currentReleaseId,
    ...lessons.map((l) => l.releaseId),
  ])) {
    const release = await db.get('course_releases', {
      id: releaseId,
      tenant_id: tenantId,
    });
    if (release)
      releaseCourseIds.set(releaseId, String(release.release_course_id));
  }
  return {
    currentReleaseId,
    lineage,
    lessons,
    releaseCourseIds,
    keysByRelease,
    pinLearnerIds: new Set(pins.map((p) => p.learnerId)),
  };
}

/**
 * Orders effective lessons for learners: the current release's own order first,
 * then lessons kept only because they were started (removed from the current
 * release) by release age and their original order. `orderOf` lists a release's
 * lesson row ids in course order.
 */
export function orderEffectiveLessons(
  selection: EnrollmentLessonSelection,
  orderOf: (releaseId: string) => ReadonlyArray<string>,
): EffectiveLessonView[] {
  const currentKeys = selection.keysByRelease.get(selection.currentReleaseId);
  const rank = (lesson: EffectiveLessonView): [number, number, number] => {
    const position = (releaseId: string, lessonId: string) => {
      const at = orderOf(releaseId).indexOf(lessonId);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    const currentId = currentKeys?.get(lesson.lessonKey);
    if (currentId)
      return [0, position(selection.currentReleaseId, currentId), 0];
    return [
      1,
      selection.lineage.indexOf(lesson.releaseId),
      position(lesson.releaseId, lesson.lessonId),
    ];
  };
  return [...selection.lessons].sort((a, b) => {
    const [a0, a1, a2] = rank(a);
    const [b0, b1, b2] = rank(b);
    return (
      a0 - b0 || a1 - b1 || a2 - b2 || a.lessonKey.localeCompare(b.lessonKey)
    );
  });
}
