import type { CourseLicenseKind } from './catalog.js';

/** Source key of the immutable Course row a release materializes. */
export const AUTHORED_RELEASE_SOURCE_KEY = 'authored-release';
/** Source key of the stable authored-course identity row. */
export const AUTHORED_IDENTITY_SOURCE_KEY = 'authored';

const RESTRICTIVENESS: Record<CourseLicenseKind, number> = {
  'own-work': 0,
  'open-license': 1,
  'licensed-for-sharing': 2,
  'personal-use-copy': 3,
};

/** The most restrictive licence among a course's parts governs the whole course. */
export function mostRestrictiveLicense(
  kinds: Iterable<CourseLicenseKind>,
): CourseLicenseKind {
  let result: CourseLicenseKind = 'own-work';
  for (const kind of kinds) {
    if (!(kind in RESTRICTIVENESS))
      throw new Error(`Unknown course licence kind: ${String(kind)}`);
    if (RESTRICTIVENESS[kind] > RESTRICTIVENESS[result]) result = kind;
  }
  return result;
}

/** Any personal-use material makes a course tenant-private, never group-shareable. */
export function isGroupShareableLicense(kind: CourseLicenseKind): boolean {
  return kind !== 'personal-use-copy';
}

/** Group-sharing eligibility for a materialized authored-release Course row. */
export function isAuthoredReleaseGroupShareable(course: {
  sourceKey?: string;
  licenseKind?: CourseLicenseKind | null;
}): boolean {
  return (
    course.sourceKey !== AUTHORED_RELEASE_SOURCE_KEY ||
    isGroupShareableLicense(course.licenseKind ?? 'own-work')
  );
}
