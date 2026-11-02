import type { DatabaseInterface } from '@happyvertical/sql';
import { COURSE_VISIBILITIES, type CourseVisibility } from './catalog.js';

/** Maps a stored value to the effective visibility: never set, or unknown, reads as 'family'. */
export function effectiveCourseVisibility(stored: unknown): CourseVisibility {
  return (COURSE_VISIBILITIES as readonly unknown[]).includes(stored)
    ? (stored as CourseVisibility)
    : 'family';
}

/**
 * Group-sharing gate for a materialized authored-release Course row. It only
 * ever NARROWS what group sharing already authorizes and never grants anything:
 *
 * - a course that is not an authored release has no visibility (unchanged);
 * - an authored course whose visibility was never recorded keeps its existing
 *   behaviour (shareable subject to every other rule), so releases made before
 *   visibility existed do not silently change;
 * - an authored course explicitly recorded as `family` (or any unknown value) is
 *   not shareable with groups;
 * - `groups` and `public` leave the existing rules in force. `public` is a
 *   listing label only: it confers no read of any kind.
 *
 * Databases that predate the release tables or the visibility column read as
 * "never recorded".
 */
export async function authoredVisibilityPermitsGroups(
  db: DatabaseInterface,
  tenantId: string,
  courseId: string,
): Promise<boolean> {
  if (!(await db.tableExists('course_releases'))) return true;
  const release = await db.get('course_releases', {
    tenant_id: tenantId,
    release_course_id: courseId,
  });
  if (!release) return true;
  const identity = await db.get('courses', {
    id: release.course_id,
    tenant_id: tenantId,
  });
  if (!identity) return false;
  const stored = identity.visibility;
  return (
    stored === undefined ||
    stored === null ||
    stored === '' ||
    stored === 'groups' ||
    stored === 'public'
  );
}
