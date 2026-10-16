/**
 * A section's page lives at `/s/<slug>/`. The slug is the layout id with its
 * `kind:` prefix turned into `kind-` (`section:sales` -> `section-sales`,
 * `custom:shop-2` -> `custom-shop-2`), so no path segment holds a colon. Only
 * the first hyphen is the prefix; the kinds (`section`, `custom`, `package`)
 * never contain one.
 */
export function sectionSlug(id: string): string {
  return id.replace(':', '-');
}

/** The layout id a slug names; the inverse of {@link sectionSlug}. */
export function sectionIdFromSlug(slug: string): string {
  return slug.replace('-', ':');
}

/** In-app path of a section's page, without the app query. */
export function sectionPath(id: string): string {
  return `/s/${sectionSlug(id)}/`;
}
