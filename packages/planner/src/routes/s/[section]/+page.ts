import { libraryCookbooks } from '$lib/library/index.ts';
import { FEATURE_SECTION } from '$lib/recipes/features.ts';
import { buildNavSections, recipes } from '$lib/recipes/index.ts';
import { sectionIdFromSlug, sectionSlug } from '$lib/sections/path.ts';
import type { EntryGenerator, PageLoad } from './$types';

// Pages for every section the app can suggest: the recipes' nav sections, More,
// and the cookbooks' custom sections. A section the visitor makes has no page
// at build time; the static host's fallback serves the app and this route
// resolves it in the browser.
export const entries: EntryGenerator = () => {
  const ids = [
    ...buildNavSections(recipes).map((s) => `section:${s.id}`),
    `section:${FEATURE_SECTION.id}`,
    ...libraryCookbooks.flatMap((c) =>
      (c.document.layout?.customSections ?? []).map((s) => s.id),
    ),
  ];
  return [...new Set(ids)].map((id) => ({ section: sectionSlug(id) }));
};

// An unknown id is not an error: it may be a section the visitor made, which
// only the page can look up once the layout is loaded.
export const load: PageLoad = ({ params }) => ({
  sectionId: sectionIdFromSlug(params.section),
});
